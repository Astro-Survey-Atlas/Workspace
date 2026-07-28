async function getJson(url) {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
        const body = (await response.json().catch(() => ({})));
        throw new Error(body.error ?? `Request failed: ${response.status}`);
    }
    return response.json();
}
async function postJson(url, body) {
    const response = await fetch(url, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({})));
        throw new Error(payload.error ?? `Request failed: ${response.status}`);
    }
    return response.json();
}
async function putJson(url, body) {
    const response = await fetch(url, {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({})));
        throw new Error(payload.error ?? `Request failed: ${response.status}`);
    }
    return response.json();
}
async function deleteRequest(url) {
    const response = await fetch(url, { method: "DELETE", headers: { Accept: "application/json" } });
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({})));
        throw new Error(payload.error ?? `Request failed: ${response.status}`);
    }
}
export const workspaceApi = {
    async dataAssets() {
        return (await getJson("/api/data-assets")).assets;
    },
    async dataAsset(id) {
        return (await getJson(`/api/data-assets/${encodeURIComponent(id)}`)).asset;
    },
    async tags() {
        return (await getJson("/api/tags")).tags;
    },
    async registerDataAsset(input) {
        return (await postJson("/api/data-assets", input)).asset;
    },
    async updateDataAsset(id, input) {
        return (await putJson(`/api/data-assets/${encodeURIComponent(id)}`, input)).asset;
    },
    async deleteDataAsset(id) {
        await deleteRequest(`/api/data-assets/${encodeURIComponent(id)}`);
    },
    async connectors() {
        return (await getJson("/api/connectors")).connectors;
    },
    async connector(id) {
        return (await getJson(`/api/connectors/${encodeURIComponent(id)}`)).connector;
    },
    async registerConnector(input) {
        return (await postJson("/api/connectors", input)).connector;
    },
    async updateConnector(id, input) {
        return (await putJson(`/api/connectors/${encodeURIComponent(id)}`, input)).connector;
    },
    async deleteConnector(id) {
        await deleteRequest(`/api/connectors/${encodeURIComponent(id)}`);
    },
    async checkConnector(id) {
        return postJson(`/api/connectors/${encodeURIComponent(id)}/check`, {});
    },
    async checkConnectorInput(input) {
        return (await postJson("/api/connectors/check", input)).check;
    },
    async connectorRuns(id) {
        return (await getJson(`/api/connectors/${encodeURIComponent(id)}/ingest-runs`)).runs;
    },
    async addConnectorRun(id, input) {
        return (await postJson(`/api/connectors/${encodeURIComponent(id)}/ingest-runs`, input)).run;
    },
    async datasets() {
        return (await getJson("/api/datasets")).datasets;
    },
    async surveys() {
        return (await getJson("/api/surveys")).surveys;
    },
    async survey(id) {
        return (await getJson(`/api/surveys/${encodeURIComponent(id)}`)).survey;
    },
    async surveyFootprints() {
        return getJson("/api/survey-footprints");
    },
    async registerSurvey(input) {
        return (await postJson("/api/surveys/registrations", input)).survey;
    },
    async skySummary(id) {
        return getJson(`/api/datasets/${encodeURIComponent(id)}/sky/summary`);
    },
    async cells(id, nside) {
        return (await getJson(`/api/datasets/${encodeURIComponent(id)}/sky/cells?nside=${nside}`)).cells;
    },
    async points(id) {
        return (await getJson(`/api/datasets/${encodeURIComponent(id)}/sky/objects?limit=50000`)).points;
    },
    async volumes() {
        return (await getJson("/api/volumes")).volumes;
    },
    async volumePoints(manifest) {
        const response = await fetch(manifest.binary.url ?? `/api/volumes/${encodeURIComponent(manifest.id)}/points.bin`, {
            headers: { Accept: "application/octet-stream" },
        });
        if (!response.ok)
            throw new Error(`Volume point request failed: ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength !== manifest.binary.byteLength) {
            throw new Error(`Volume payload is ${buffer.byteLength} bytes; expected ${manifest.binary.byteLength}`);
        }
        return decodeVolumePoints(buffer, manifest.pointCount);
    },
    async atlases() {
        return (await getJson("/api/atlases")).atlases;
    },
    async atlasAngularCells(manifest) {
        const response = await fetch(manifest.angularBinary.url ?? `/api/atlases/${encodeURIComponent(manifest.id)}/angular-cells.bin`);
        if (!response.ok)
            throw new Error(`Atlas angular request failed: ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength !== manifest.angularBinary.byteLength)
            throw new Error("Atlas angular payload length mismatch");
        return decodeAtlasAngularCells(buffer);
    },
    async jointCells(atlasId, query) {
        const parameters = new URLSearchParams();
        Object.entries(query).forEach(([key, value]) => {
            if (value != null)
                parameters.set(key, String(value));
        });
        return getJson(`/api/atlases/${encodeURIComponent(atlasId)}/joint?${parameters}`);
    },
    async refinement(atlasId, query) {
        return getJson(`/api/atlases/${encodeURIComponent(atlasId)}/refinement?${new URLSearchParams(Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)])))}`);
    },
    async tools() {
        return (await getJson("/api/tools")).tools;
    },
    async workflows() {
        return (await getJson("/api/workflows")).workflows;
    },
    async createWorkflowRun(workflowId, input) {
        return (await postJson("/api/workflow-runs", { workflowId, input })).run;
    },
    async workflowRun(id) {
        return (await getJson(`/api/workflow-runs/${encodeURIComponent(id)}`)).run;
    },
    async decideWorkflowRun(id, decision) {
        return (await postJson(`/api/workflow-runs/${encodeURIComponent(id)}/decisions`, decision)).run;
    },
    async createAgentSession(workflowId) {
        return (await postJson("/api/agent/sessions", { workflowId })).session;
    },
    async sendAgentMessage(sessionId, message) {
        return postJson(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`, { message });
    },
};
import { decodeAtlasAngularCells, } from "../../src/atlas-format";
import { decodeVolumePoints } from "../../src/volume-format";
