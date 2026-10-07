// Builds the synthetic import fixture in memory: a copy of the client's real
// spec sheet STRUCTURE (doc/reference/client-sample-sheet.xlsx, local only)
// with made-up values, so CI can test the importer without the real file.
//
// Structure copied from the real sheet (plan "Fixture findings"):
// - one sheet "Sheet1"; row 1 = 33 headers "English\nChinese" with the real
//   case/space quirks (HOLDER, Voltage INPUT, LUMEN Output, stray spaces,
//   "NO." with no Chinese line), header cells as rich text;
// - row 2 blank (a spacer);
// - rows 3-14: Nos. 76-81, two rows each, NO. only on the first row; 80 and
//   81 have no Model No. and almost no specs;
// - bilingual cells "English\n\nChinese" as rich text; NO. and Power Factor
//   as number cells; "-" for not applicable;
// - one PNG anchored oneCell in column 6 (Image) on every data row; the same
//   picture on all rows of Nos. 76+77, another on 78+79.
// Arc No. 76 uses the public values from the plan's golden section.

import ExcelJS from "exceljs";
import sharp from "sharp";

type CellValue = ExcelJS.CellValue;

/** Options that produce variants of the fixture for specific tests. */
export interface FixtureOptions {
  /** Merge NO. A3:A4 and Model Name B3:B10 (a common hand-made layout). */
  merged?: boolean;
  /** Add "Sheet2" with the same headers and No. 82, plus a "Notes" sheet with no header. */
  secondSheet?: boolean;
  /** Add an unknown header in column 34 ("Remarks\n备注") with a value on row 3. */
  unknownColumn?: boolean;
  /** Row 3 Wattage as a formula with the cached result "12W". */
  formula?: boolean;
  /** Row 5 Wattage as a formula with no cached result. */
  formulaWithoutResult?: boolean;
  /** Blank out a required column (header and values). */
  missingColumn?: "productNo" | "modelNo";
  /** Row 5 Cut-out Size as a date cell (what Excel does to "3/4"). */
  dateCell?: boolean;
  /** Hide row 6. */
  hiddenRow?: boolean;
  /** Turn Lumen Output on row 3 into a hyperlink cell. */
  hyperlink?: boolean;
  /** Rows whose picture is anchored twoCell (from + to) instead of oneCell. */
  twoCellRows?: readonly number[];
  /** Data rows that get NO picture (default: every data row has one). */
  noImageRows?: readonly number[];
  /** Row 4 (AR-013A2) carries its own picture E instead of picture A. */
  variantPicture?: boolean;
  /** Also anchor picture E in column 14 of row 3 (two pictures on a row). */
  secondPictureOnRow3?: boolean;
  /** Extra rows (e.g. the blank row 2) that get picture A anchored. */
  extraImageRows?: readonly number[];
}

/** The 0-based column the fixture anchors pictures in (Image = column 6). */
export const FIXTURE_IMAGE_COLUMN = 5;

/*
 * The 33 header cells, in sheet order, exactly as the real sheet spells them
 * (the English line is what the importer matches).
 */
export const FIXTURE_HEADERS: readonly string[] = [
  "NO.",
  "Model Name\n型号名称",
  "Model Type\n型号类型",
  "Model No.\n型号",
  "Batch No.\n批号 ",
  "Image\n图片",
  "Housing Material\n外壳材质",
  "Housing Color/Finish\n外壳颜色/表面处理",
  "Reflector Color\n反光杯颜色",
  "Lens\n透镜",
  "Reflector\n反光杯",
  "Diffuser\n扩散器",
  "Cut-out Size\n开孔尺寸",
  "Dimensions\n尺寸",
  "Rotating Angle\n摆动角",
  "Chip Type\n芯片型号",
  "HOLDER\n支架",
  "Chip Efficiency\n 芯片光效",
  "CCT\n色温",
  "CRI\n显色指数",
  "Beam Angle\n光束角",
  "UGR\n防眩值",
  "Driver\n驱动电源",
  "Voltage INPUT\n输入电压 ",
  "Wattage\n功率",
  "LUMEN Output\n光通量",
  "Lumen Efficiency\n光效",
  "Power Factor\n功率因数",
  "SDCM\n色容差",
  "Dimmable\n可调光 ",
  "Lifespan\n使用寿命",
  "IP Rating\n防护等级",
  "Warranty Period\n质保期",
];

/** Excel row numbers of the data rows (row 1 = header, row 2 = blank). */
export const FIXTURE_DATA_ROWS: readonly number[] = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
];

/* 1-based column numbers used below. */
const COL = {
  no: 1,
  name: 2,
  type: 3,
  modelNo: 4,
  image: 6,
  material: 7,
  finish: 8,
  lens: 10,
  reflector: 11,
  cutOut: 13,
  dimensions: 14,
  chipType: 16,
  cct: 19,
  cri: 20,
  beam: 21,
  driver: 23,
  voltage: 24,
  wattage: 25,
  lumen: 26,
  efficiency: 27,
  powerFactor: 28,
  sdcm: 29,
  lifespan: 31,
  ip: 32,
} as const;

/** A rich text cell made of runs, like WPS writes bilingual cells. */
function rich(...runs: string[]): CellValue {
  return { richText: runs.map((text) => ({ text })) };
}

/** A header cell: plain for "NO.", rich text "English\n" + "Chinese" otherwise. */
function headerCell(header: string): CellValue {
  const cut = header.indexOf("\n");
  if (cut === -1) return header;
  return rich(header.slice(0, cut + 1), header.slice(cut + 1));
}

const TYPE_TRIM = rich(
  "Pull-Down Spot Light\nTrim Round 1 Head\n\n",
  "伸缩有边框圆形单头射灯",
);
const TYPE_TRIMLESS = rich(
  "Pull-Down Spot Light\nTrimless Round 1 Head\n\n",
  "伸缩无边框圆形单头射灯",
);
const MATERIAL = rich("Die Casting\nAluminium + PC\n\n", "压铸铝", " + PC ");
const FINISH = rich("White/Black\n\n", "白色", "/", "黑色");
const LENS = rich("Regular Lens\n\n", "普通透镜");
const REFLECTOR = rich("High Effciency Reflector\n\n", "高效反光杯");
const DRIVER = rich("Lifud ", "莱福德");

interface ProductSpec {
  no: number;
  base: string;
  type: CellValue;
  cutOut: string;
  dimensions: string;
  wattage: string;
  lumens: [string, string];
}

/* Nos. 76-79: two variants each, lens (…1) and reflector (…2). */
const PRODUCTS: readonly ProductSpec[] = [
  {
    no: 76,
    base: "AR-013A",
    type: TYPE_TRIM,
    cutOut: "Ø90mm",
    dimensions: "D100*H110mm",
    wattage: "12W",
    lumens: ["1140 LM", "1200 LM"],
  },
  {
    no: 77,
    base: "AR-013B",
    type: TYPE_TRIM,
    cutOut: "Ø105mm",
    dimensions: "D118*H125mm",
    wattage: "18W",
    lumens: ["1710 LM", "1800 LM"],
  },
  {
    no: 78,
    base: "AR-013C",
    type: TYPE_TRIMLESS,
    cutOut: "Ø85mm",
    dimensions: "140*D88*H105mm",
    wattage: "10W",
    lumens: ["950 LM", "1000 LM"],
  },
  {
    no: 79,
    base: "AR-013D",
    type: TYPE_TRIM,
    cutOut: "Ø120mm",
    dimensions: "170*D115*H125mm",
    wattage: "24W",
    lumens: ["2280 LM", "2400 LM"],
  },
];

/** The cells of one full variant row of Nos. 76-79. */
function variantRow(
  product: ProductSpec,
  variant: 0 | 1,
): Map<number, CellValue> {
  const cells = new Map<number, CellValue>();
  if (variant === 0) cells.set(COL.no, product.no);
  cells.set(COL.name, "Arc");
  cells.set(COL.type, product.type);
  cells.set(COL.modelNo, `${product.base}${variant + 1}`);
  cells.set(COL.material, MATERIAL);
  cells.set(COL.finish, FINISH);
  // Lens variant: lens, reflector "-". Reflector variant: the other way round.
  cells.set(COL.lens, variant === 0 ? LENS : "-");
  cells.set(COL.reflector, variant === 0 ? "-" : REFLECTOR);
  cells.set(COL.cutOut, product.cutOut);
  cells.set(COL.dimensions, product.dimensions);
  cells.set(COL.chipType, "COB");
  cells.set(COL.cct, "3000K\n4000K");
  cells.set(COL.cri, ">90");
  cells.set(COL.beam, "20°\n30°\n40°\n60°");
  cells.set(COL.driver, DRIVER);
  cells.set(COL.voltage, "AC220-240V");
  cells.set(COL.wattage, product.wattage);
  cells.set(COL.lumen, product.lumens[variant]);
  cells.set(COL.efficiency, variant === 0 ? "95±" : "100±");
  cells.set(COL.powerFactor, 0.9);
  cells.set(COL.sdcm, "≤3");
  cells.set(COL.lifespan, "50,000 hrs ");
  cells.set(COL.ip, "IP20");
  return cells;
}

/** Nos. 80/81: family, material, finish only; continuation row = family. */
function sparseRows(no: number): Map<number, CellValue>[] {
  const first = new Map<number, CellValue>([
    [COL.no, no],
    [COL.name, "Arc"],
    [COL.material, MATERIAL],
    [COL.finish, FINISH],
  ]);
  return [first, new Map<number, CellValue>([[COL.name, "Arc"]])];
}

/** A tiny solid-colour PNG, so every picture has distinct bytes. */
async function png(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();
}

function writeHeaders(sheet: ExcelJS.Worksheet, extra: string[] = []): void {
  [...FIXTURE_HEADERS, ...extra].forEach((header, i) => {
    sheet.getCell(1, i + 1).value = headerCell(header);
  });
}

function writeRow(
  sheet: ExcelJS.Worksheet,
  row: number,
  cells: Map<number, CellValue>,
): void {
  for (const [col, value] of cells) sheet.getCell(row, col).value = value;
}

/**
 * Anchors an image in a column (default: Image, col 6) of an Excel row:
 * oneCell by default, twoCell (from + to, like the real sheet) on request.
 */
function anchorImage(
  sheet: ExcelJS.Worksheet,
  imageId: number,
  row: number,
  {
    twoCell = false,
    col = COL.image,
  }: { twoCell?: boolean; col?: number } = {},
): void {
  // exceljs uses 0-based col/row here; no `br` = oneCellAnchor.
  if (twoCell) {
    // exceljs accepts plain {col,row} corners at runtime; its types want the
    // full Anchor class, hence the cast.
    const range = {
      tl: { col: col - 1, row: row - 1 },
      br: { col: col - 0.5, row: row - 0.5 },
    } as unknown as ExcelJS.ImageRange;
    sheet.addImage(imageId, { ...range, editAs: "oneCell" });
    return;
  }
  sheet.addImage(imageId, {
    tl: { col: col - 1, row: row - 1 },
    ext: { width: 64, height: 64 },
    editAs: "oneCell",
  });
}

/** The five fixture pictures (8x8 solid PNGs), A-D as the real sheet, E extra. */
export async function fixturePictures(): Promise<Buffer[]> {
  return Promise.all([
    png(200, 40, 40),
    png(40, 200, 40),
    png(40, 40, 200),
    png(200, 200, 40),
    png(40, 200, 200),
  ]);
}

/**
 * The synthetic client sheet as .xlsx bytes. Without options it mirrors the
 * real sheet; each option adds one variation a test needs.
 */
export async function buildFixture(
  options: FixtureOptions = {},
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  writeHeaders(sheet, options.unknownColumn ? ["Remarks\n备注"] : []);
  // Row 2 stays blank (the real sheet's spacer row).

  const rows: Map<number, CellValue>[] = [];
  for (const product of PRODUCTS) {
    rows.push(variantRow(product, 0), variantRow(product, 1));
  }
  rows.push(...sparseRows(80), ...sparseRows(81));
  rows.forEach((cells, i) => writeRow(sheet, i + 3, cells));

  // Pictures: A on Nos. 76+77 (rows 3-6), B on 78+79 (7-10), C on 80, D on 81.
  // E is only registered when an option uses it (the default has 4 media).
  const useE = options.variantPicture || options.secondPictureOnRow3;
  const pictures = (await fixturePictures()).slice(0, useE ? 5 : 4);
  const ids = pictures.map((buffer) =>
    workbook.addImage({
      buffer: buffer as unknown as ExcelJS.Buffer,
      extension: "png",
    }),
  );
  const pictureE = ids[4] as number;
  const pictureForRow = (row: number) => {
    if (options.variantPicture && row === 4) return pictureE;
    return ids[row <= 6 ? 0 : row <= 10 ? 1 : row <= 12 ? 2 : 3] as number;
  };
  const twoCell = new Set(options.twoCellRows ?? []);
  const skipped = new Set(options.noImageRows ?? []);
  for (const row of FIXTURE_DATA_ROWS) {
    if (skipped.has(row)) continue;
    anchorImage(sheet, pictureForRow(row), row, { twoCell: twoCell.has(row) });
  }
  if (options.secondPictureOnRow3) {
    anchorImage(sheet, pictureE, 3, { col: COL.dimensions });
  }
  for (const row of options.extraImageRows ?? []) {
    anchorImage(sheet, ids[0] as number, row);
  }

  applyOptions(workbook, sheet, options);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function applyOptions(
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  options: FixtureOptions,
): void {
  if (options.unknownColumn) sheet.getCell(3, 34).value = "Sample note";
  if (options.formula) {
    sheet.getCell(3, COL.wattage).value = {
      formula: '"12"&"W"',
      result: "12W",
    } as CellValue;
  }
  if (options.formulaWithoutResult) {
    sheet.getCell(5, COL.wattage).value = { formula: '"18"&"W"' } as CellValue;
  }
  if (options.dateCell) {
    sheet.getCell(5, COL.cutOut).value = new Date(Date.UTC(2026, 2, 4));
  }
  if (options.hyperlink) {
    sheet.getCell(3, COL.lumen).value = {
      text: "1140 LM",
      hyperlink: "https://example.com/arc",
    };
  }
  if (options.hiddenRow) sheet.getRow(6).hidden = true;
  if (options.missingColumn) {
    const col = options.missingColumn === "productNo" ? COL.no : COL.modelNo;
    const last = FIXTURE_DATA_ROWS[FIXTURE_DATA_ROWS.length - 1] as number;
    for (let row = 1; row <= last; row++) sheet.getCell(row, col).value = null;
  }
  if (options.merged) {
    // exceljs keeps the master's value; covered cells must be empty first.
    sheet.getCell(4, COL.no).value = null;
    for (let row = 4; row <= 10; row++)
      sheet.getCell(row, COL.name).value = null;
    sheet.mergeCells(3, COL.no, 4, COL.no);
    sheet.mergeCells(3, COL.name, 10, COL.name);
  }
  if (options.secondSheet) {
    const second = workbook.addWorksheet("Sheet2");
    writeHeaders(second);
    const product: ProductSpec = {
      no: 82,
      base: "AR-014A",
      type: TYPE_TRIM,
      cutOut: "Ø75mm",
      dimensions: "D85*H95mm",
      wattage: "7W",
      lumens: ["660 LM", "700 LM"],
    };
    writeRow(second, 2, variantRow(product, 0));
    writeRow(second, 3, variantRow(product, 1));
    const notes = workbook.addWorksheet("Notes");
    notes.getCell(1, 1).value = "Prices are not part of this sheet.";
  }
}
