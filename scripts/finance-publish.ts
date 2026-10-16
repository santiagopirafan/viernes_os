import { publicarEnGoogleSheets } from "../src/finance/googleSheets.js";

async function main() {
  console.log(await publicarEnGoogleSheets());
}

main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
