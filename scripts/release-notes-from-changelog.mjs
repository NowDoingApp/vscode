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

const sections = headings.map((start, index) => {
  const end = headings[index + 1] ?? lines.length;
  const heading = lines[start].slice(3).trim();
  const body = lines.slice(start + 1, end).join("\n").trim();

  return { heading, body };
});

if (sections[0] && !sections[0].body) {
  throw new Error(`latest changelog entry \"${sections[0].heading}\" has no body`);
}

let selected = sections[0];

if (requestedVersion) {
  const versionRegex = new RegExp(`\\b${requestedVersion.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`);
  const byVersion = sections.find((section) =>
    versionRegex.test(section.heading) || versionRegex.test(section.body)
  );

  if (byVersion) {
    selected = byVersion;
  } else {
    // Date-based changelogs may not include the semver in headings.
    // Fall back to newest entry so release automation does not fail hard.
    process.stderr.write(
      `warning: no changelog section matched version ${requestedVersion}; using latest section \"${selected.heading}\"\n`
    );
  }
}

if (!selected?.body) {
  throw new Error("no changelog section body available for release notes");
}

process.stdout.write(`${selected.body}\n`);