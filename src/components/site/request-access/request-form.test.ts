// The pure rules of the /request-access form (P6): FormData shape, the state
// for each service answer (one "sent" for every accepted outcome), the page
// parameters, the WhatsApp link, and that the country list and the anti-spam
// field names agree with the server's schema and service.

import { describe, expect, it } from "vitest";

import {
  ACCESS_REQUEST_THANKS,
  ACCESS_REQUEST_UNAVAILABLE,
  HONEYPOT_FIELD,
  STARTED_AT_FIELD,
} from "@/lib/access-requests";
import { countrySchema } from "@/lib/schemas/access-request";

import { COUNTRIES, OTHER_COUNTRY } from "./countries";
import {
  FIELD_ERRORS_SUMMARY,
  FORM_REFUSED,
  HONEYPOT_NAME,
  STARTED_AT_NAME,
  readRequestForm,
  refusedState,
  requestPageParams,
  stateForAnswer,
  whatsappRequestHref,
} from "./request-form";

const MESSAGES = {
  thanks: ACCESS_REQUEST_THANKS,
  unavailable: ACCESS_REQUEST_UNAVAILABLE,
};
const ID = "0123456789abcdef01234567";

function form(entries: Record<string, string | Blob>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

describe("anti-spam field names", () => {
  it("match the service's", () => {
    expect(HONEYPOT_NAME).toBe(HONEYPOT_FIELD);
    expect(STARTED_AT_NAME).toBe(STARTED_AT_FIELD);
  });
});

describe("countries", () => {
  it("every choice passes the server's country schema unchanged", () => {
    for (const country of COUNTRIES) {
      const parsed = countrySchema.safeParse(country);
      expect(parsed.success, country).toBe(true);
      expect(parsed.data).toBe(country);
    }
  });

  it("is unique, sorted, ends with Other and leaves out mainland China", () => {
    expect(new Set(COUNTRIES).size).toBe(COUNTRIES.length);
    const named = COUNTRIES.slice(0, -1);
    expect(named).toEqual([...named].sort((a, b) => a.localeCompare(b, "en")));
    expect(COUNTRIES.at(-1)).toBe(OTHER_COUNTRY);
    expect(COUNTRIES).not.toContain("China");
    for (const allowed of ["Hong Kong", "Macao", "Taiwan"]) {
      expect(COUNTRIES).toContain(allowed);
    }
  });
});

describe("readRequestForm", () => {
  it("keeps the known string fields only", () => {
    expect(
      readRequestForm(
        form({
          name: "Ada",
          email: "ada@example.com",
          consent: "on",
          [HONEYPOT_NAME]: "",
          [STARTED_AT_NAME]: "123",
          $ACTION_ID_abc: "",
          role: "admin",
        }),
      ),
    ).toEqual({
      name: "Ada",
      email: "ada@example.com",
      company: "",
      country: "",
      consent: "on",
      website: "",
      startedAt: "123",
    });
  });

  it("drops a file in a text field but counts one in the honeypot as filled", () => {
    const posted = readRequestForm(
      form({
        name: new Blob(["x"]),
        [HONEYPOT_NAME]: new Blob(["x"]),
      }),
    );
    expect(posted?.name).toBe("");
    expect(posted?.website).toBe("file");
  });

  it("refuses an absurdly long field", () => {
    expect(readRequestForm(form({ message: "x".repeat(20_001) }))).toBeNull();
    expect(
      readRequestForm(form({ message: "x".repeat(20_000) })),
    ).not.toBeNull();
  });
});

describe("stateForAnswer", () => {
  const posted = {
    name: "<b>",
    email: "ada@example.com",
    company: "Acme",
    country: "Japan",
    phone: "",
    message: "Hi",
    consent: undefined,
    website: "",
    startedAt: "1700000000000",
  };

  it("one identical sent state for every accepted answer, with no values", () => {
    const sent = stateForAnswer({ ok: true }, posted, MESSAGES);
    expect(sent).toEqual({ status: "sent", message: ACCESS_REQUEST_THANKS });
    expect(stateForAnswer({ ok: true }, null, MESSAGES)).toEqual(sent);
  });

  it("maps field errors, keeps the values and the first start time", () => {
    const state = stateForAnswer(
      {
        ok: false,
        errors: {
          formErrors: [],
          fieldErrors: {
            name: ["Use letters", "second"],
            consent: ["Please accept the privacy notice"],
          },
        },
      },
      posted,
      MESSAGES,
    );
    expect(state).toEqual({
      status: "invalid",
      fieldErrors: {
        name: "Use letters",
        consent: "Please accept the privacy notice",
      },
      formError: FIELD_ERRORS_SUMMARY,
      values: {
        name: "<b>",
        email: "ada@example.com",
        company: "Acme",
        country: "Japan",
        phone: "",
        message: "Hi",
        consent: false,
      },
      startedAt: "1700000000000",
    });
  });

  it("an error only on a hidden field asks to reload", () => {
    const state = stateForAnswer(
      {
        ok: false,
        errors: { formErrors: [], fieldErrors: { kind: ["Invalid option"] } },
      },
      posted,
      MESSAGES,
    );
    expect(state).toMatchObject({
      status: "invalid",
      fieldErrors: {},
      formError: FORM_REFUSED,
    });
  });

  it("our outage keeps the values and says so", () => {
    expect(
      stateForAnswer({ ok: false, unavailable: true }, posted, MESSAGES),
    ).toMatchObject({
      status: "unavailable",
      message: ACCESS_REQUEST_UNAVAILABLE,
      values: { email: "ada@example.com" },
      startedAt: "1700000000000",
    });
  });

  it("a refused shape echoes nothing", () => {
    expect(refusedState()).toEqual({
      status: "invalid",
      fieldErrors: {},
      formError: FORM_REFUSED,
      values: {},
      startedAt: null,
    });
  });
});

describe("requestPageParams", () => {
  it("reads renew=1 and a valid product id, given once", () => {
    expect(
      requestPageParams({ renew: "1", product: ID.toUpperCase() }),
    ).toEqual({
      renew: true,
      productId: ID,
    });
    expect(requestPageParams({})).toEqual({ renew: false, productId: null });
  });

  it("ignores anything else", () => {
    for (const product of ["abc", `${ID}x`, [ID, ID], "<script>", ""]) {
      expect(requestPageParams({ product }).productId).toBeNull();
    }
    for (const renew of ["true", "0", ["1", "1"], "yes"]) {
      expect(requestPageParams({ renew }).renew).toBe(false);
    }
  });
});

describe("whatsappRequestHref", () => {
  const BASE = "https://wa.me/85291234567";

  it("is null without a number", () => {
    expect(
      whatsappRequestHref(null, { renew: false, product: "Arc AR-013A" }),
    ).toBeNull();
  });

  it("prefills the product name, URL-encoded", () => {
    const href = whatsappRequestHref(BASE, {
      renew: false,
      product: "Arc & Co AR-013A?",
    });
    expect(href).toBe(
      `${BASE}?text=${encodeURIComponent("Hello, I would like to request datasheet access for Arc & Co AR-013A?.")}`,
    );
    const url = new URL(href ?? "");
    expect(url.searchParams.get("text")).toContain("Arc & Co AR-013A?");
    expect([...url.searchParams.keys()]).toEqual(["text"]);
  });

  it("words a renewal and works without a product", () => {
    expect(
      new URL(
        whatsappRequestHref(BASE, { renew: true, product: null }) ?? "",
      ).searchParams.get("text"),
    ).toBe("Hello, I would like to renew my datasheet access.");
  });
});
