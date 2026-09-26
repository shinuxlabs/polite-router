import assert from "node:assert/strict";
import { findCount } from "../lib/facts.js";
import { searchWeb } from "../lib/grok.js";

const cases = [
  ["View All Inventory 791 vehicles in stock", "791"],
  ["Showing 1 - 35 of 1,204 results", "1204"],
  ["Access Denied You don't have permission", ""],
  ["8 vehicles under $15,000", "8"],
];

for (const [text, expected] of cases) {
  const got = findCount(text);
  assert.equal(got, expected, `findCount(${text}) => ${got}, expected ${expected}`);
}

const blockedBrowser = { pages: [{ title: "Access Denied", excerpt: "Access Denied" }] };
assert.equal(findCount(blockedBrowser.pages.map((p) => p.excerpt).join(" ")), "");

let search = await searchWeb("how many vehicles are listed at toyotaofdeerfieldbeach.com");
if (!search?.text) search = await searchWeb("Toyota of Deerfield Beach used inventory vehicle count");
const counted = findCount(search?.text || "");
console.log(JSON.stringify({
  searchOk: Boolean(search?.text),
  error: search?.error || "",
  counted,
  preview: String(search?.text || "").slice(0, 500),
}, null, 2));

if (!counted) {
  console.error("backtest: search did not produce a vehicle count");
  process.exit(2);
}
console.log("backtest: count", counted);
