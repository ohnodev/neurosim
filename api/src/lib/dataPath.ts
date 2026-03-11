/**
 * Single canonical path for all persistent JSON stores.
 * All store files live under this directory; no legacy paths.
 */
import path from 'path';
import { fileURLToPath } from 'url';

const _dir = path.dirname(fileURLToPath(import.meta.url));
/** api/data when running from api/dist (compiled) or api/src (ts-node). */
export const DATA_DIR = path.join(_dir, '../../data');

export function dataPath(filename: string): string {
  return path.join(DATA_DIR, filename);
}
