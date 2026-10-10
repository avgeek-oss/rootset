import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const template = await readFile(
  new URL("../.env.example", import.meta.url),
  "utf8",
);
const credential = () => randomBytes(32).toString("hex");
const replacements: Record<string, string> = {
  REPLACE_POSTGRES_PASSWORD: credential(),
  REPLACE_OBJECT_ACCESS_KEY: randomBytes(16).toString("hex"),
  REPLACE_OBJECT_SECRET_KEY: credential(),
};
let output = template.replace(
  /REPLACE_[A-Z_]+/g,
  (token) => replacements[token] ?? token,
);
output = output
  .replace(/GENERATE_AT_LEAST_32_RANDOM_BYTES/g, () => credential())
  .replace("GENERATE_32_RANDOM_BYTES_AS_64_HEX_DIGITS", credential());
await writeFile(".env", output, { flag: "wx", mode: 0o600 });
console.log(
  "Created .env with fresh credentials, one application secret and one encryption key. Keep a protected recovery copy before storing data.",
);
