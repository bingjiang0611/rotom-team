/** Checks the separately installed product, not a global command or the maintainer's checkout. */
import { verifyRotomKernel } from "../src/server/rotom-kernel.ts";
const { version } = verifyRotomKernel();

console.log(
    `Pinned rotom ${version}: bootstrap identity verified; launch still requires product runtime gates.`,
);
