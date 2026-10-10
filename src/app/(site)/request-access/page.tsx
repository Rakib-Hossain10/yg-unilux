// /request-access (Phase 5 P6, plan Q2/Q3/Q6, ADR 0069): the public form to
// ask for datasheet access, or to renew it (?renew=1, the datasheet route's
// and /my-downloads' target). ?product=<id> names the published product the
// visitor came from; anything else in it is ignored. A signed-in user's
// name, email, company and country are prefilled from the DATABASE session.
// Rendered per request (it reads the session and the query), so Next sends
// `private, no-store`; never indexed. Metadata holds no visitor data.

import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";

import { textLink } from "@/components/site/account/account-ui";
import { productTitle } from "@/components/site/product/product-display";
import { COUNTRIES } from "@/components/site/request-access/countries";
import { RequestAccessForm } from "@/components/site/request-access/request-access-form";
import {
  requestPageParams,
  whatsappRequestHref,
  type RequestFormValues,
} from "@/components/site/request-access/request-form";
import { logAuthProblem } from "@/lib/auth";
import {
  getPublishedProductLabel,
  type PublishedProductLabel,
} from "@/lib/catalog/product-ref";
import { getWhatsappNumber, whatsappLink } from "@/lib/contact-settings";
import { issueFormStamp } from "@/lib/form-stamp";
import { getViewer, type Viewer } from "@/lib/permissions";
import { countrySchema } from "@/lib/schemas/access-request";
import { hasSessionCookie } from "@/lib/session-cookie";

export const metadata: Metadata = {
  title: "Request datasheet access",
  description:
    "Ask YG UniLUX for access to product datasheets. One approval opens every datasheet on the site.",
  robots: { index: false, follow: true },
};

/* The signed-in viewer, or null; a failed read just means no prefill. */
async function currentViewer(): Promise<Viewer | null> {
  if (!hasSessionCookie(await headers())) return null;
  try {
    return await getViewer();
  } catch (error) {
    logAuthProblem("session not read on /request-access", error);
    return null;
  }
}

/* The product the visitor came from, or null (draft, unknown, outage). */
async function productFor(
  productId: string | null,
): Promise<PublishedProductLabel | null> {
  if (!productId) return null;
  try {
    return await getPublishedProductLabel(productId);
  } catch (error) {
    console.error(
      `[request-access] product not read: ${error instanceof Error ? error.name : "unknown error"}`,
    );
    return null;
  }
}

const asText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/* The fields a signed-in user's account already knows. */
function prefillFor(viewer: Viewer | null): RequestFormValues {
  if (!viewer) return {};
  const user = viewer.user as Viewer["user"] & {
    company?: unknown;
    country?: unknown;
  };
  return {
    name: asText(user.name),
    email: asText(user.email),
    company: asText(user.company),
    country: asText(user.country),
  };
}

/*
 * A stored country outside the list is offered as an extra first choice
 * when the schema accepts it; otherwise the select starts empty.
 */
function withCountryChoice(values: RequestFormValues): {
  prefill: RequestFormValues;
  extraCountry: string | null;
} {
  const stored = values.country;
  if (stored === undefined || COUNTRIES.includes(stored)) {
    return { prefill: values, extraCountry: null };
  }
  const parsed = countrySchema.safeParse(stored);
  return parsed.success
    ? {
        prefill: { ...values, country: parsed.data },
        extraCountry: parsed.data,
      }
    : { prefill: { ...values, country: undefined }, extraCountry: null };
}

const STEPS: Record<"new" | "renew", readonly string[]> = {
  new: [
    "We read every request ourselves and reply by email.",
    "Once approved, you receive a link to set your password.",
    "Sign in, and every product page offers its datasheet as an Excel file.",
  ],
  renew: [
    "We check your account and the access you had.",
    "We extend your access and confirm the new end date by email.",
    "Sign in as before; downloads work again straight away.",
  ],
};

export default async function RequestAccessPage({
  searchParams,
}: PageProps<"/request-access">) {
  const { renew, productId } = requestPageParams(await searchParams);
  const [viewer, product, digits] = await Promise.all([
    currentViewer(),
    productFor(productId),
    getWhatsappNumber(),
  ]);

  const productName = product ? productTitle(product) : null;
  const productPath = product ? `/product/${product.slug}` : null;
  const whatsapp = whatsappRequestHref(digits ? whatsappLink(digits) : null, {
    renew,
    product: productName,
  });
  const { prefill, extraCountry } = withCountryChoice(prefillFor(viewer));

  const afterSent: ReactNode = (
    <>
      {productPath && productName ? (
        <a href={productPath} className={textLink}>
          Back to {productName}
        </a>
      ) : null}
      <Link href="/products" className={textLink}>
        Browse products
      </Link>
    </>
  );

  return (
    <div className="mx-auto w-full max-w-(--container-site) px-4 py-14 md:px-8 md:py-20 lg:py-24">
      <div className="grid gap-12 lg:grid-cols-12 lg:grid-rows-[auto_1fr] lg:gap-x-16 lg:gap-y-10">
        <header className="lg:col-span-5 lg:row-start-1">
          <h1 className="font-display text-4xl leading-[1.05] font-light text-balance md:text-5xl lg:text-6xl">
            {renew ? "Renew datasheet access" : "Request datasheet access"}
          </h1>
          <p className="mt-5 max-w-md text-[0.9375rem] leading-relaxed text-pretty text-grey-700">
            {renew
              ? "When access ends, your sign-in still works but downloads pause. Send this form and we will extend it."
              : "Technical datasheets are shared with trade customers we know. One approval opens every datasheet on the site."}
          </p>

          {productName && productPath ? (
            <div
              data-request-product
              className="mt-8 border-t border-grey-200 pt-5"
            >
              <p className="text-sm text-grey-600">You came from</p>
              <p className="mt-1 font-display text-2xl leading-tight">
                {productName}
              </p>
              <a href={productPath} className={`${textLink} text-sm`}>
                Back to the product
              </a>
            </div>
          ) : null}
        </header>

        <div className="lg:col-span-7 lg:col-start-6 lg:row-span-2 lg:row-start-1 lg:border-l lg:border-grey-200 lg:pl-16">
          <div className="max-w-2xl">
            <RequestAccessForm
              renew={renew}
              productId={product?.productId ?? null}
              startedAt={issueFormStamp()}
              prefill={prefill}
              extraCountry={extraCountry}
              submitLabel={renew ? "Send renewal request" : "Send request"}
              afterSent={afterSent}
            />
          </div>
        </div>

        {/* Below the form on small screens, beside it from lg. */}
        <aside className="lg:col-span-5 lg:row-start-2">
          <section
            aria-labelledby="request-steps"
            className="border-t border-grey-200 pt-6"
          >
            <h2 id="request-steps" className="text-sm font-medium">
              What happens next
            </h2>
            <ol className="mt-4 space-y-4">
              {STEPS[renew ? "renew" : "new"].map((step, index) => (
                <li
                  key={step}
                  className="grid grid-cols-[1.75rem_1fr] text-sm leading-relaxed text-grey-700"
                >
                  <span
                    aria-hidden="true"
                    className="font-display text-lg leading-tight text-grey-500 lining-nums"
                  >
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </section>

          {whatsapp ? (
            <p className="mt-10 border-t border-grey-200 pt-6 text-sm text-grey-700">
              Prefer a conversation?{" "}
              <a
                href={whatsapp}
                target="_blank"
                rel="noopener noreferrer"
                data-whatsapp
                className={textLink}
              >
                Message us on WhatsApp
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </p>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
