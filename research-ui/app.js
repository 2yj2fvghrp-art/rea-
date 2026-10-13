import {
  scopeFields,
  findingFields,
  value,
  textFields,
  normalizeCase,
  missingCaseFacts,
  startingCommand,
  caseToMarkdown,
} from "./case.js";

const byId = (id) => document.getElementById(id);
const readField = (id) => byId(id).value;
const setControlValue = (control, input) => {
  const next = value(input);
  if (
    control instanceof HTMLSelectElement &&
    next &&
    !Array.from(control.options).some((option) => option.value === next)
  )
    control.add(new Option(next, next));
  control.value = next;
};
const writeField = (id, input) => {
  setControlValue(byId(id), input);
};
let createdAt = new Date().toISOString();
let policyDigest = "";
let digestRequest = 0;

const newScopeRow = (scope = {}) => {
  const row = document.createElement("div");
  row.className = "scope-row";
  row.innerHTML = `
    <label>Asset kind<select data-field="kind"><option value="">Select kind</option><option value="android_package">Android package</option><option value="ios_bundle">iOS bundle</option><option value="desktop_product">Desktop product</option><option value="domain">Domain</option><option value="api_origin">API origin</option><option value="other">Other</option></select></label>
    <label>Exact identifier<input data-field="identifier" placeholder="com.example.app" /></label>
    <label>Versions / environment<input data-field="versions" placeholder="Versions named in policy" /></label>
    <label>Policy reference<input data-field="policy_reference" placeholder="Section or exact line" /></label>
    <button class="remove" type="button" aria-label="Remove scope entry">×</button>`;
  for (const name of scopeFields)
    setControlValue(row.querySelector(`[data-field="${name}"]`), scope[name]);
  row.querySelector(".remove").addEventListener("click", () => {
    row.remove();
    renderReview();
  });
  byId("scopeRows").append(row);
};

const newFindingRow = (finding = {}) => {
  const row = document.createElement("div");
  row.className = "finding-row";
  row.innerHTML = `
    <div class="finding-top"><label>Candidate title<input data-field="title" placeholder="Specific question or suspected boundary" /></label><button class="remove" type="button" aria-label="Remove candidate">×</button></div>
    <div class="finding-grid">
      <label>Candidate ID<input data-field="id" placeholder="C-1" /></label>
      <label>REA Evidence IDs<input data-field="evidence_refs" placeholder="Exact IDs from saved output" /></label>
      <label class="full">Entry point → check → affected operation<textarea data-field="entry_point" rows="2"></textarea></label>
      <label class="full">Observation and source location<textarea data-field="observation" rows="3"></textarea></label>
      <label>Inference and competing explanations<textarea data-field="inference" rows="3"></textarea></label>
      <label>Unknowns and follow-up<textarea data-field="unknowns" rows="3"></textarea></label>
      <label>Controlled reproduction<textarea data-field="reproduction" rows="3"></textarea></label>
      <label>Observed impact<textarea data-field="impact" rows="3"></textarea></label>
    </div>`;
  for (const name of findingFields)
    row.querySelector(`[data-field="${name}"]`).value = value(finding[name]);
  row.querySelector(".remove").addEventListener("click", () => {
    row.remove();
    renderReview();
  });
  byId("findingRows").append(row);
};

const collectRows = (id, fields) =>
  Array.from(byId(id).children, (row) =>
    Object.fromEntries(
      fields.map((name) => [
        name,
        row.querySelector(`[data-field="${name}"]`).value,
      ]),
    ),
  );

const collectCase = () =>
  normalizeCase({
    schema_version: 1,
    created_at: createdAt,
    updated_at: new Date().toISOString(),
    fields: Object.fromEntries(
      textFields.map((name) => [name, readField(name)]),
    ),
    scopes: collectRows("scopeRows", scopeFields).filter((row) =>
      Object.values(row).some(Boolean),
    ),
    findings: collectRows("findingRows", findingFields).filter((row) =>
      Object.values(row).some(Boolean),
    ),
    policy_sha256: policyDigest,
  });

const exportCase = async () => {
  const researchCase = collectCase();
  researchCase.policy_sha256 = researchCase.fields.policyText
    ? await hexDigest(researchCase.fields.policyText)
    : "";
  return researchCase;
};

const hexDigest = async (text) => {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const renderReview = () => {
  const researchCase = collectCase();
  const missing = missingCaseFacts(researchCase);
  const list = byId("missingList");
  list.replaceChildren();
  if (missing.length === 0) {
    const item = document.createElement("li");
    item.className = "done";
    item.textContent =
      "Core intake fields recorded. Recheck current rules before live testing.";
    list.append(item);
  } else {
    for (const fact of missing) {
      const item = document.createElement("li");
      item.textContent = fact;
      list.append(item);
    }
  }
  byId("caseStatus").textContent =
    missing.length === 0 ? "Intake recorded" : `${missing.length} missing`;
  byId("caseStatus").classList.toggle("complete", missing.length === 0);
  byId("commandPreview").textContent = startingCommand(researchCase);
};

const updatePolicyDigest = async () => {
  const request = ++digestRequest;
  const text = readField("policyText");
  const digest = text ? await hexDigest(text) : "";
  if (request !== digestRequest) return;
  policyDigest = digest;
  byId("policyDigest").textContent = digest || "Add policy text";
  renderReview();
};

const fileBase = (programName) => {
  const name = programName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return name || "rea-research-case";
};
const download = (name, contents, type) => {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  byId("saveNote").textContent =
    `Downloaded ${name}. Keep the case and policy snapshot together.`;
};

const loadCase = async (file) => {
  if (file.size > 8 * 1024 * 1024)
    throw new Error("Case JSON exceeds the 8 MiB import limit.");
  const loaded = normalizeCase(JSON.parse(await file.text()));
  if (
    loaded.fields.policyText &&
    loaded.policy_sha256 &&
    loaded.policy_sha256 !== (await hexDigest(loaded.fields.policyText))
  )
    throw new Error("The policy text does not match the saved SHA-256.");
  createdAt = loaded.created_at || new Date().toISOString();
  for (const name of textFields) writeField(name, loaded.fields[name]);
  byId("scopeRows").replaceChildren();
  for (const scope of loaded.scopes) newScopeRow(scope);
  if (loaded.scopes.length === 0) newScopeRow();
  byId("findingRows").replaceChildren();
  for (const finding of loaded.findings) newFindingRow(finding);
  await updatePolicyDigest();
  byId("saveNote").textContent =
    `Loaded ${file.name}. Review current rules before continuing.`;
};

if (typeof document !== "undefined") {
  newScopeRow();
  byId("addScope").addEventListener("click", () => {
    if (byId("scopeRows").children.length >= 100) {
      byId("saveNote").textContent =
        "This case has 100 scope rows. Start another case for more assets.";
      return;
    }
    newScopeRow();
    renderReview();
  });
  byId("addFinding").addEventListener("click", () => {
    if (byId("findingRows").children.length >= 100) {
      byId("saveNote").textContent =
        "This case has 100 candidate rows. Start another case for more findings.";
      return;
    }
    newFindingRow({ id: `C-${byId("findingRows").children.length + 1}` });
    renderReview();
  });
  document.addEventListener("input", (event) => {
    if (event.target?.id === "policyText") void updatePolicyDigest();
    else renderReview();
  });
  document.addEventListener("change", (event) => {
    if (event.target?.id !== "loadCase") renderReview();
  });
  byId("downloadJson").addEventListener("click", async () => {
    const researchCase = await exportCase();
    download(
      `${fileBase(researchCase.fields.programName)}.json`,
      JSON.stringify(researchCase, null, 2) + "\n",
      "application/json",
    );
  });
  byId("downloadMarkdown").addEventListener("click", async () => {
    const researchCase = await exportCase();
    download(
      `${fileBase(researchCase.fields.programName)}.md`,
      caseToMarkdown(researchCase),
      "text/markdown; charset=utf-8",
    );
  });
  byId("downloadPolicy").addEventListener("click", () => {
    const text = readField("policyText");
    if (!text) {
      byId("saveNote").textContent =
        "Add the exact policy text before downloading its snapshot.";
      return;
    }
    download(
      `${fileBase(readField("programName"))}-policy.txt`,
      text,
      "text/plain; charset=utf-8",
    );
  });
  byId("loadCase").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    try {
      await loadCase(file);
    } catch (cause) {
      byId("saveNote").textContent = `Could not load case: ${String(cause)}`;
    }
    event.target.value = "";
  });
  renderReview();
}
