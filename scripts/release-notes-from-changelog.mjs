import { readFileSync } from "node:fs";

const requestedVersion = process.argv[2]?.replace(/^v/, "") ?? "";
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

const lines = changelog.split(/\r?\n/);
const headings = [];

for (let index = 0; index < lines.length; index += 1) {
  if (lines[index].startsWith("## ")) {
    headings.push(index);
  }
}

if (headings.length === 0) {
  throw new Error("CHANGELOG.md does not contain any release headings");
}

const firstHeadingIndex = headings[0];
const firstHeading = lines[firstHeadingIndex].slice(3).trim();

if (requestedVersion && !firstHeading.includes(requestedVersion)) {
  throw new Error(
    `latest changelog heading \"${firstHeading}\" does not match version ${requestedVersion}`
  );
}

const nextHeadingIndex = headings[1] ?? lines.length;
const body = lines.slice(firstHeadingIndex + 1, nextHeadingIndex).join("\n").trim();

if (!body) {
  throw new Error(`latest changelog entry \"${firstHeading}\" has no body`);
}

process.stdout.write(`${body}\n`);