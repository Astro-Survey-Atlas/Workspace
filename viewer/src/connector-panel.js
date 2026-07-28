import { workspaceApi } from "./api";
function byId(id) {
    const element = document.getElementById(id);
    if (!element)
        throw new Error(`Missing required element: ${id}`);
    return element;
}
function field(form, name) {
    return String(new FormData(form).get(name) ?? "").trim();
}
const KIND_LABELS = { s3: "S3 / OSS", local: "本地路径", jdbc: "JDBC 数据库" };
const STATUS_LABELS = { draft: "草稿", ready: "可用", disabled: "停用" };
function connectorLocation(record) { return record.displayPath; }
function statusPill(record) {
    const status = document.createElement("span");
    status.className = "connector-status";
    status.dataset.status = record.lastCheck?.status === "ok" ? "ready" : record.lastCheck?.status === "failed" ? "disabled" : record.status;
    status.textContent = record.lastCheck?.status === "ok" ? "连接正常" : record.lastCheck?.status === "failed" ? "检测失败" : STATUS_LABELS[record.status];
    return status;
}
function setFeedback(target, status, summary, detail = "") {
    target.dataset.status = status;
    const title = document.createElement("strong");
    title.textContent = summary;
    const note = document.createElement("small");
    note.textContent = detail;
    target.replaceChildren(title, ...(detail ? [note] : []));
}
function checkFeedback(check) {
    const feedback = document.createElement("div");
    feedback.className = "connector-check-feedback";
    feedback.setAttribute("aria-live", "polite");
    if (check)
        setFeedback(feedback, check.status, check.summary, check.detail ?? "");
    else
        setFeedback(feedback, "unknown", "尚未检测连接", "测试只验证当前路径和权限，不扫描目录。 ");
    return feedback;
}
export class ConnectorPanel {
    #onError;
    #records = [];
    #selectedId = null;
    #editingId = null;
    #active = false;
    #detailGeneration = 0;
    constructor(onError) {
        this.#onError = onError;
        byId("connector-kind").addEventListener("change", () => this.#renderConfigFieldsFrom(byId("connector-registration-form"), true));
        byId("connector-registration-form").addEventListener("submit", (event) => {
            event.preventDefault();
            void this.#register().catch((error) => this.#registrationFeedback("failed", "登记失败", error));
        });
        byId("connector-form-cancel").addEventListener("click", () => this.#resetRegistrationForm());
        byId("connector-delete").addEventListener("click", () => void this.#remove().catch(this.#onError));
        byId("connector-check-form").addEventListener("click", () => void this.#checkRegistrationInput());
    }
    async activate(selectedId) {
        this.#active = true;
        this.#records = await workspaceApi.connectors();
        if (selectedId && this.#records.some((record) => record.id === selectedId))
            this.#selectedId = selectedId;
        if (!this.#selectedId || !this.#records.some((record) => record.id === this.#selectedId))
            this.#selectedId = this.#records[0]?.id ?? null;
        this.#resetRegistrationForm();
        this.#render();
    }
    select(id) {
        this.#selectedId = id;
        this.#editingId = null;
        if (this.#active)
            this.#render();
    }
    deactivate() {
        this.#active = false;
        this.#editingId = null;
    }
    #renderConfigFieldsFrom(form, requireNewSecret) {
        const kind = form.elements.namedItem("kind").value;
        form.querySelectorAll("[data-config]").forEach((element) => { element.hidden = element.dataset.config !== kind; });
        form.elements.namedItem("bucket")?.toggleAttribute("required", kind === "s3");
        form.elements.namedItem("accessKeyId")?.toggleAttribute("required", kind === "s3");
        form.elements.namedItem("secretAccessKey")?.toggleAttribute("required", kind === "s3" && requireNewSecret);
        form.elements.namedItem("rootPath")?.toggleAttribute("required", kind === "local");
        form.elements.namedItem("url")?.toggleAttribute("required", kind === "jdbc");
    }
    #render() {
        if (!this.#active)
            return;
        const list = byId("connector-list");
        list.replaceChildren(...this.#records.map((record) => {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "connector-row";
            row.classList.toggle("selected", record.id === this.#selectedId);
            row.addEventListener("click", () => { this.#selectedId = record.id; this.#editingId = null; this.#render(); if (window.innerWidth <= 1040)
                byId("inspector-panel").classList.add("mobile-open"); });
            const identity = document.createElement("span");
            const name = document.createElement("strong");
            name.textContent = record.name;
            const note = document.createElement("small");
            note.textContent = record.description;
            identity.append(name, note);
            const location = document.createElement("span");
            location.className = "connector-location";
            location.textContent = connectorLocation(record);
            location.title = connectorLocation(record);
            const kind = document.createElement("span");
            kind.textContent = KIND_LABELS[record.kind];
            row.append(identity, location, kind, statusPill(record));
            return row;
        }));
        byId("connector-empty").hidden = this.#records.length > 0;
        byId("connector-count").textContent = String(this.#records.length);
        byId("connector-draft-count").textContent = String(this.#records.filter((record) => record.status === "draft").length);
        byId("connector-ready-count").textContent = String(this.#records.filter((record) => record.status === "ready" || record.lastCheck?.status === "ok").length);
        this.#renderDetail();
    }
    #renderDetail() {
        const record = this.#records.find((candidate) => candidate.id === this.#selectedId);
        const empty = byId("inspector-empty");
        const content = byId("inspector-content");
        byId("inspector-kicker").textContent = this.#editingId ? "EDIT CONNECTOR" : "CONNECTOR DETAIL";
        if (!record) {
            empty.hidden = false;
            content.hidden = true;
            content.replaceChildren();
            byId("connector-detail").hidden = true;
            return;
        }
        empty.hidden = true;
        content.hidden = false;
        const root = document.createElement("div");
        root.className = "connector-inspector-detail";
        if (this.#editingId === record.id)
            root.append(this.#editForm(record));
        else
            root.append(...this.#detailView(record));
        const runsHeading = document.createElement("div");
        runsHeading.className = "section-heading connector-runs-heading";
        runsHeading.innerHTML = "<span>FlinkIngest / 扫描记录</span>";
        const runs = document.createElement("div");
        runs.className = "connector-runs";
        runs.textContent = "载入记录…";
        root.append(runsHeading, runs);
        content.replaceChildren(root);
        void this.#loadRuns(record, runs);
    }
    #detailView(record) {
        const heading = document.createElement("h2");
        heading.textContent = record.name;
        const pathValue = document.createElement("code");
        pathValue.className = "connector-detail-path";
        pathValue.textContent = connectorLocation(record);
        const description = document.createElement("p");
        description.className = "catalog-detail-copy";
        description.textContent = record.description;
        const summary = document.createElement("dl");
        const rows = [["类型", KIND_LABELS[record.kind]], ["状态", STATUS_LABELS[record.status]]];
        if (record.kind === "s3") {
            rows.push(["Bucket", record.config.bucket ?? ""], ["Prefix", record.config.prefix || "根目录"], ["Access Key", record.credentials.accessKeyId || "未配置"], ["Secret Key", record.credentials.secretConfigured ? "••••••••••••" : "未配置"]);
        }
        rows.forEach(([label, value]) => {
            const row = document.createElement("div");
            const term = document.createElement("dt");
            const detail = document.createElement("dd");
            term.textContent = label;
            detail.textContent = value;
            row.append(term, detail);
            summary.append(row);
        });
        const feedback = checkFeedback(record.lastCheck);
        const actions = document.createElement("div");
        actions.className = "inspector-actions";
        const checkButton = document.createElement("button");
        checkButton.type = "button";
        checkButton.className = "command-button";
        checkButton.textContent = "检测连接";
        checkButton.addEventListener("click", () => void this.#checkSelected(checkButton, feedback));
        const editButton = document.createElement("button");
        editButton.type = "button";
        editButton.className = "command-button secondary";
        editButton.textContent = "编辑配置";
        editButton.addEventListener("click", () => { this.#editingId = record.id; this.#renderDetail(); });
        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "command-button danger";
        deleteButton.textContent = "删除";
        deleteButton.addEventListener("click", () => void this.#remove().catch(this.#onError));
        actions.append(checkButton, editButton, deleteButton);
        return [heading, pathValue, statusPill(record), description, summary, feedback, actions];
    }
    #editForm(record) {
        const form = document.createElement("form");
        form.className = "connector-inline-editor";
        form.innerHTML = `<label class="connector-edit-title"><span>名称</span><input name="name" class="field-input" maxlength="120" required></label><label><span>说明</span><textarea name="description" class="field-input" maxlength="500" rows="3"></textarea></label><div class="connector-config-grid"><label><span>类型</span><select name="kind" class="field-input"><option value="s3">S3 / OSS</option><option value="local">本地路径</option><option value="jdbc">JDBC 数据库</option></select></label><label><span>状态</span><select name="status" class="field-input"><option value="draft">草稿</option><option value="ready">可用</option><option value="disabled">停用</option></select></label></div><div data-config="s3" class="connector-config-grid"><label><span>Endpoint</span><input name="endpoint" class="field-input"></label><label><span>Bucket</span><input name="bucket" class="field-input"></label><label><span>Prefix</span><input name="prefix" class="field-input"></label><label><span>Region</span><input name="region" class="field-input"></label><label><span>Access Key</span><input name="accessKeyId" class="field-input" autocomplete="off"></label><label><span>Secret Key</span><input name="secretAccessKey" class="field-input" type="password" autocomplete="new-password" placeholder="已保存；留空保持不变"></label></div><div data-config="local" class="connector-config-grid" hidden><label><span>根路径</span><input name="rootPath" class="field-input"></label></div><div data-config="jdbc" class="connector-config-grid" hidden><label><span>JDBC URL</span><input name="url" class="field-input"></label><label><span>Database</span><input name="database" class="field-input"></label><label><span>Schema</span><input name="schema" class="field-input"></label></div><output class="connector-edit-feedback" aria-live="polite"></output><div class="detail-editor-actions"><button class="command-button" type="submit">保存修改</button><button class="command-button secondary" type="button" data-cancel>取消</button></div>`;
        const set = (name, value) => { const element = form.elements.namedItem(name); if (element)
            element.value = value; };
        set("name", record.name);
        set("description", record.description);
        set("kind", record.kind);
        set("status", record.status);
        set("endpoint", record.config.endpoint ?? "");
        set("bucket", record.config.bucket ?? "");
        set("prefix", record.config.prefix ?? "");
        set("region", record.config.region ?? "us-east-1");
        set("accessKeyId", record.credentials.accessKeyId);
        set("rootPath", record.config.rootPath ?? "");
        set("url", record.config.url ?? "");
        set("database", record.config.database ?? "");
        set("schema", record.config.schema ?? "public");
        form.elements.namedItem("kind").addEventListener("change", () => this.#renderConfigFieldsFrom(form, false));
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            const output = form.querySelector(".connector-edit-feedback");
            setFeedback(output, "checking", "正在保存…");
            void this.#saveEdit(record, form).catch((error) => setFeedback(output, "failed", "保存失败", error instanceof Error ? error.message : String(error)));
        });
        form.querySelector("[data-cancel]")?.addEventListener("click", () => { this.#editingId = null; this.#renderDetail(); });
        this.#renderConfigFieldsFrom(form, false);
        return form;
    }
    #inputFromForm(form) {
        const kind = field(form, "kind");
        const config = kind === "s3" ? { endpoint: field(form, "endpoint"), bucket: field(form, "bucket"), prefix: field(form, "prefix"), region: field(form, "region") } : kind === "local" ? { rootPath: field(form, "rootPath") } : { url: field(form, "url"), database: field(form, "database"), schema: field(form, "schema") };
        const secretAccessKey = field(form, "secretAccessKey");
        return { name: field(form, "name"), description: field(form, "description") || undefined, kind, config, credentials: kind === "s3" ? { accessKeyId: field(form, "accessKeyId"), ...(secretAccessKey ? { secretAccessKey } : {}) } : undefined, status: field(form, "status") };
    }
    async #register() {
        const form = byId("connector-registration-form");
        if (!form.reportValidity()) {
            this.#registrationFeedback("failed", "信息不完整", "请补全当前 Connector 所需字段。 ");
            return;
        }
        this.#registrationFeedback("checking", "正在保存 Connector…");
        const record = await workspaceApi.registerConnector(this.#inputFromForm(form));
        this.#records = await workspaceApi.connectors();
        this.#selectedId = record.id;
        this.#resetRegistrationForm();
        this.#render();
    }
    async #saveEdit(record, form) {
        if (!form.reportValidity())
            return;
        const updated = await workspaceApi.updateConnector(record.id, this.#inputFromForm(form));
        this.#records = await workspaceApi.connectors();
        this.#selectedId = updated.id;
        this.#editingId = null;
        this.#render();
    }
    async #checkSelected(button, feedback) {
        const id = this.#selectedId;
        if (!id)
            return;
        button.disabled = true;
        button.textContent = "检测中…";
        setFeedback(feedback, "checking", "正在验证已保存凭据和访问权限…");
        try {
            const result = await workspaceApi.checkConnector(id);
            this.#records = this.#records.map((record) => record.id === id ? result.connector : record);
            this.#render();
        }
        catch (error) {
            button.disabled = false;
            button.textContent = "重新检测";
            setFeedback(feedback, "failed", "连接检测失败", error instanceof Error ? error.message : String(error));
        }
    }
    async #checkRegistrationInput() {
        const form = byId("connector-registration-form");
        const button = byId("connector-check-form");
        if (!form.reportValidity()) {
            this.#registrationFeedback("failed", "信息不完整", "请补全路径和凭据后重试。 ");
            return;
        }
        button.disabled = true;
        button.textContent = "检测中…";
        this.#registrationFeedback("checking", "正在验证连接与权限…");
        try {
            const check = await workspaceApi.checkConnectorInput(this.#inputFromForm(form));
            this.#registrationFeedback(check.status, check.summary, check.detail ?? "");
        }
        catch (error) {
            this.#registrationFeedback("failed", "连接检测失败", error);
        }
        finally {
            button.disabled = false;
            button.textContent = "检测此配置";
        }
    }
    #registrationFeedback(status, summary, detail) {
        setFeedback(byId("connector-form-message"), status, summary, detail instanceof Error ? detail.message : typeof detail === "string" ? detail : "");
    }
    async #loadRuns(record, target) {
        const generation = ++this.#detailGeneration;
        try {
            const runs = await workspaceApi.connectorRuns(record.id);
            if (!this.#active || generation !== this.#detailGeneration || this.#selectedId !== record.id)
                return;
            target.replaceChildren(...(runs.length ? runs.map((run) => this.#runRow(run)) : [this.#emptyRunRow()]));
        }
        catch (error) {
            target.textContent = error instanceof Error ? error.message : String(error);
        }
    }
    #runRow(run) {
        const row = document.createElement("div");
        row.className = "connector-run-row";
        const title = document.createElement("strong");
        title.textContent = run.jobId ?? run.batchId ?? run.id;
        const meta = document.createElement("small");
        meta.textContent = `${run.status} · ${run.assetName ?? "未绑定资产"} · ${run.fileCount ?? 0} files`;
        row.append(title, meta);
        return row;
    }
    #emptyRunRow() { const row = document.createElement("div"); row.className = "connector-run-empty"; row.textContent = "还没有 FlinkIngest / 扫描记录。"; return row; }
    #resetRegistrationForm() {
        this.#editingId = null;
        const form = byId("connector-registration-form");
        form.reset();
        form.elements.namedItem("kind").value = "s3";
        form.elements.namedItem("status").value = "draft";
        form.elements.namedItem("region").value = "us-east-1";
        form.elements.namedItem("schema").value = "public";
        this.#renderConfigFieldsFrom(form, true);
        this.#registrationFeedback("unknown", "尚未检测", "填写后可先检测连接，也可以直接登记。 ");
    }
    async #remove() {
        if (!this.#selectedId)
            return;
        await workspaceApi.deleteConnector(this.#selectedId);
        this.#records = await workspaceApi.connectors();
        this.#selectedId = this.#records[0]?.id ?? null;
        this.#resetRegistrationForm();
        this.#render();
    }
}
