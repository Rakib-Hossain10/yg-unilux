// The admin URLs of the areas module, built in one place so the actions'
// redirects, the list's links and the pages never disagree. The base comes
// from the module list (admin-sections.ts).

import { ADMIN_SECTIONS } from "./admin-sections";

export const AREAS_PATH = ADMIN_SECTIONS.areas.href;
export const NEW_AREA_PATH = `${AREAS_PATH}/new`;

/** Edit page of one area. */
export function areaEditPath(id: string): string {
  return `${AREAS_PATH}/${encodeURIComponent(id)}`;
}
