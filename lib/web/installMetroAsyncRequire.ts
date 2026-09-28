/**
 * Side-effect entry for the Metro async-bundle loader.
 *
 * Imports are hoisted above every statement in the entry file, so a plain
 * function call in `index.js` would run only after the whole static graph has
 * evaluated. A dependency that fires a dynamic import while its own module body
 * runs would then still hit the missing loader. Importing this module first
 * installs the loader before the rest of the graph evaluates.
 */
import { installMetroAsyncRequire } from "./metroAsyncRequire";

installMetroAsyncRequire();
