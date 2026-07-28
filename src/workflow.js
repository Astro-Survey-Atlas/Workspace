export class ToolRegistry {
    #tools = new Map();
    register(descriptor, handler) {
        if (this.#tools.has(descriptor.id))
            throw new Error(`Tool already registered: ${descriptor.id}`);
        this.#tools.set(descriptor.id, { descriptor: structuredClone(descriptor), handler });
    }
    list() {
        return [...this.#tools.values()].map(({ descriptor }) => structuredClone(descriptor));
    }
    get(id) {
        const registered = this.#tools.get(id);
        if (!registered)
            throw new Error(`Tool not found: ${id}`);
        return structuredClone(registered.descriptor);
    }
    updateHealth(id, health) {
        const registered = this.#tools.get(id);
        if (!registered)
            throw new Error(`Tool not found: ${id}`);
        registered.descriptor.health = structuredClone(health);
    }
    async invoke(id, input, context) {
        const registered = this.#tools.get(id);
        if (!registered)
            throw new Error(`Tool not found: ${id}`);
        return registered.handler(input, context);
    }
}
export function validateWorkflowDefinition(definition, tools) {
    if (definition.key !== `${definition.id}@${definition.version}`) {
        throw new Error(`Workflow key must be ${definition.id}@${definition.version}`);
    }
    const stepById = new Map();
    for (const step of definition.steps) {
        if (stepById.has(step.id))
            throw new Error(`Duplicate workflow step: ${step.id}`);
        if (step.kind !== "human_gate" && !step.toolId)
            throw new Error(`Step ${step.id} requires a tool`);
        if (step.kind === "human_gate" && step.toolId)
            throw new Error(`Human gate ${step.id} cannot declare a tool`);
        if (step.toolId && tools)
            tools.get(step.toolId);
        stepById.set(step.id, step);
    }
    for (const step of definition.steps) {
        for (const dependency of step.dependsOn) {
            if (!stepById.has(dependency))
                throw new Error(`Step ${step.id} depends on missing step ${dependency}`);
            if (dependency === step.id)
                throw new Error(`Step ${step.id} cannot depend on itself`);
        }
    }
    const visiting = new Set();
    const visited = new Set();
    const visit = (stepId) => {
        if (visiting.has(stepId))
            throw new Error(`Workflow contains a cycle at ${stepId}`);
        if (visited.has(stepId))
            return;
        visiting.add(stepId);
        for (const dependency of stepById.get(stepId)?.dependsOn ?? [])
            visit(dependency);
        visiting.delete(stepId);
        visited.add(stepId);
    };
    for (const step of definition.steps)
        visit(step.id);
}
export class WorkflowRegistry {
    tools;
    #definitions = new Map();
    constructor(tools) {
        this.tools = tools;
    }
    register(definition) {
        validateWorkflowDefinition(definition, this.tools);
        if (this.#definitions.has(definition.key))
            throw new Error(`Workflow already registered: ${definition.key}`);
        this.#definitions.set(definition.key, structuredClone(definition));
    }
    list() {
        return [...this.#definitions.values()].map((definition) => structuredClone(definition));
    }
    get(key) {
        const definition = this.#definitions.get(key);
        if (!definition)
            throw new Error(`Workflow not found: ${key}`);
        return structuredClone(definition);
    }
}
