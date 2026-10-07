// Minimal Open XML package helpers for the image stage (images.ts): a small
// XML reader for the few parts we need (workbook, relationships, drawings)
// and relationship target resolution. Pure: text in, tree out.
//
// The XML comes from an untrusted upload, so the reader is a single linear
// scan (no regex backtracking), never expands entities beyond the five
// predefined ones and character references, refuses any DOCTYPE, and caps
// the node count and depth. Namespace prefixes are dropped: `xdr:row` and
// `row` are the same element, which is what tolerating other writers needs.

/** One XML element. `name` and attribute names are local (prefix dropped). */
export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** The element's own text content (direct text children, decoded). */
  text: string;
}

export interface XmlLimits {
  maxNodes: number;
  maxDepth: number;
}

const DEFAULT_LIMITS: XmlLimits = { maxNodes: 500_000, maxDepth: 128 };

/**
 * Parses one XML document. Returns the document element, or null when the
 * text is not well-formed enough to trust, has a DOCTYPE, or passes a limit.
 */
export function parseXml(
  text: string,
  limits: XmlLimits = DEFAULT_LIMITS,
): XmlElement | null {
  const root: XmlElement = { name: "", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  let nodes = 0;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const lt = text.indexOf("<", i);
    const top = stack[stack.length - 1] as XmlElement;
    if (lt === -1) {
      top.text += decodeEntities(text.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(text.slice(i, lt));

    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      if (end === -1) return null;
      i = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      if (end === -1) return null;
      top.text += text.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt + 2);
      if (end === -1) return null;
      i = end + 2;
      continue;
    }
    // <!DOCTYPE ...> (and entity declarations): never needed in OOXML.
    if (text.startsWith("<!", lt)) return null;

    const close = tagEnd(text, lt + 1);
    if (close === -1) return null;
    const body = text.slice(lt + 1, close);
    i = close + 1;

    if (body.startsWith("/")) {
      const name = localName(body.slice(1).trim());
      const open = stack.pop();
      if (open === undefined || stack.length === 0 || open.name !== name) {
        return null;
      }
      continue;
    }

    const selfClosing = body.endsWith("/");
    const tag = parseTag(selfClosing ? body.slice(0, -1) : body);
    if (tag === null) return null;
    nodes += 1;
    if (nodes > limits.maxNodes) return null;
    if (stack.length === 1 && root.children.length > 0) return null; // 2 roots
    // Depth of the new element: the document element is depth 1.
    if (stack.length > limits.maxDepth) return null;
    top.children.push(tag);
    if (!selfClosing) stack.push(tag);
  }
  if (stack.length !== 1) return null;
  return root.children[0] ?? null;
}

/* The index of the ">" closing a tag that starts at `from`, quotes skipped. */
function tagEnd(text: string, from: number): number {
  let quote = "";
  for (let j = from; j < text.length; j++) {
    const c = text[j];
    if (quote !== "") {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return j;
    }
  }
  return -1;
}

const isSpace = (c: string | undefined) =>
  c === " " || c === "\t" || c === "\n" || c === "\r";

/* "name attr='v' b="w"" → element; null when malformed. Linear scan. */
function parseTag(body: string): XmlElement | null {
  let j = 0;
  const n = body.length;
  while (j < n && !isSpace(body[j])) j++;
  const name = localName(body.slice(0, j));
  if (name === "") return null;
  // No prototype: an attribute named "constructor" is just an attribute.
  const attrs: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (;;) {
    while (j < n && isSpace(body[j])) j++;
    if (j >= n) break;
    const start = j;
    while (j < n && body[j] !== "=" && !isSpace(body[j])) j++;
    const attr = localName(body.slice(start, j));
    while (j < n && isSpace(body[j])) j++;
    if (body[j] !== "=") return null;
    j++;
    while (j < n && isSpace(body[j])) j++;
    const quote = body[j];
    if (quote !== '"' && quote !== "'") return null;
    const end = body.indexOf(quote, j + 1);
    if (end === -1) return null;
    // First occurrence wins (e.g. r:id vs a plain id on one element).
    if (attr !== "" && !Object.hasOwn(attrs, attr)) {
      attrs[attr] = decodeEntities(body.slice(j + 1, end));
    }
    j = end + 1;
  }
  return { name, attrs, children: [], text: "" };
}

function localName(qualified: string): string {
  const colon = qualified.lastIndexOf(":");
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

const PREDEFINED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/* The five predefined entities and numeric references; others left as is. */
function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g,
    (whole, ref: string) => {
      if (!ref.startsWith("#")) return PREDEFINED[ref] ?? whole;
      const code =
        ref[1] === "x"
          ? parseInt(ref.slice(2), 16)
          : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    },
  );
}

/** Direct children with a (local) name. */
export function childrenNamed(el: XmlElement, name: string): XmlElement[] {
  return el.children.filter((c) => c.name === name);
}

/** The first direct child with a (local) name. */
export function childNamed(
  el: XmlElement,
  name: string,
): XmlElement | undefined {
  return el.children.find((c) => c.name === name);
}

/** Every descendant with a (local) name, in document order. */
export function descendantsNamed(el: XmlElement, name: string): XmlElement[] {
  const found: XmlElement[] = [];
  const pending = [...el.children].reverse();
  while (pending.length > 0) {
    const next = pending.pop() as XmlElement;
    if (next.name === name) found.push(next);
    for (let k = next.children.length - 1; k >= 0; k--) {
      pending.push(next.children[k] as XmlElement);
    }
  }
  return found;
}

/** One relationship of a part's .rels file. */
export interface Relationship {
  type: string;
  /** Package path (no leading "/") for an internal target; the raw URL for an external one. */
  target: string;
  external: boolean;
}

/** "xl/worksheets/sheet1.xml" → "xl/worksheets/_rels/sheet1.xml.rels". */
export function relsPathFor(part: string): string {
  const slash = part.lastIndexOf("/");
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

/**
 * The relationships of a parsed .rels document, by id. Internal targets are
 * resolved against `sourcePart`; one that escapes the package root is
 * dropped (it can only point at nothing).
 */
export function readRelationships(
  rels: XmlElement,
  sourcePart: string,
): Map<string, Relationship> {
  const out = new Map<string, Relationship>();
  for (const rel of childrenNamed(rels, "Relationship")) {
    const id = rel.attrs.Id;
    const target = rel.attrs.Target;
    if (id === undefined || target === undefined || out.has(id)) continue;
    const type = rel.attrs.Type ?? "";
    if (rel.attrs.TargetMode === "External") {
      out.set(id, { type, target, external: true });
      continue;
    }
    const path = resolveTarget(sourcePart, target);
    if (path !== null) out.set(id, { type, target: path, external: false });
  }
  return out;
}

/**
 * Resolves a relationship target against the part that owns it:
 * ("xl/drawings/drawing1.xml", "../media/image1.png") → "xl/media/image1.png";
 * a target starting with "/" is from the package root. null = it climbs
 * above the root or is empty.
 */
export function resolveTarget(
  sourcePart: string,
  target: string,
): string | null {
  let raw: string;
  try {
    raw = decodeURIComponent(target.split("#", 1)[0] ?? "");
  } catch {
    return null;
  }
  // A target names a part (a file), never a folder.
  if (raw === "" || raw.endsWith("/")) return null;
  const base = raw.startsWith("/") ? [] : sourcePart.split("/").slice(0, -1);
  const segments = [...base];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.length === 0 ? null : segments.join("/");
}
