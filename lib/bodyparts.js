// The body-part list lives with the capture app in ~/fitted, so the page and the
// pipeline can never disagree about what a body part measures.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FITTED } from './paths.js';

const mod = await import(pathToFileURL(join(FITTED, 'capture', 'bodyparts.js')).href);
export const { BODY_PARTS, labelFor } = mod;

/** The list the dashboard shows. */
export const partList = () => Object.entries(BODY_PARTS).map(([id, p]) => ({ id, label: p.label, sided: p.sided, tracker: p.tracker }));
