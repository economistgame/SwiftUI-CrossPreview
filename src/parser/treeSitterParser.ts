/**
 * SwiftUI -> ViewNode conversion on top of the tree-sitter Swift grammar
 * (web-tree-sitter / tree-sitter-wasms grammar).
 *
 * A preview is static, so runtime logic is resolved to a representative result:
 *   - `let`/`var` declared in `body` are tracked and used when evaluating.
 *   - `if` / `else if` / `else`, `switch` and `a ? b : c` pick the branch that
 *     matches the known initial values (@State, @Published, default values,
 *     arguments passed to helpers/subviews). Unknown conditions take the first
 *     branch.
 *   - Helper functions (`func campo(...) -> some View`), computed view
 *     properties and View structs declared in the same file are inlined with
 *     their arguments bound. Views from other files become a "Custom" marker.
 */
import { ViewNode, Modifier } from './viewTree';

type TSNode = any;

export interface TreeSitterParseResult {
    root: ViewNode | null;
    errors: string[];
}

// ---------------------------------------------------------------------------
// Values and environment
// ---------------------------------------------------------------------------

type Value =
    | { kind: 'string'; value: string }
    | { kind: 'number'; value: number }
    | { kind: 'bool'; value: boolean }
    | { kind: 'enum'; value: string }
    | { kind: 'array'; value: Value[] }
    | { kind: 'unknown' };

const UNKNOWN: Value = { kind: 'unknown' };

interface VarBinding {
    node?: TSNode;
    env?: Env;
    value?: Value;
}

class Env {
    private vars = new Map<string, VarBinding>();
    constructor(readonly parent: Env | null, readonly owner: StructInfo | null) {}

    set(name: string, binding: VarBinding): void {
        this.vars.set(name, binding);
    }

    lookup(name: string): VarBinding | undefined {
        return this.vars.get(name) ?? this.parent?.lookup(name);
    }

    child(owner: StructInfo | null = this.owner): Env {
        return new Env(this, owner);
    }
}

interface Param {
    label: string | null; // external label (null for `_`)
    name: string;         // internal name
    defaultValue?: TSNode;
}

interface StructInfo {
    name: string;
    isView: boolean;
    stored: Array<{ name: string; defaultValue?: TSNode }>;
    funcs: Map<string, { params: Param[]; body: TSNode | null }>;
    viewProps: Map<string, TSNode>; // computed properties -> statements node
}

interface Context {
    structs: Map<string, StructInfo>;
    globals: Env;          // every property initial value in the file, by name
    depth: number;
    inlining: Set<string>; // guards against recursive inlining
}

const MAX_DEPTH = 12;

// ---------------------------------------------------------------------------
// Small tree helpers
// ---------------------------------------------------------------------------

function named(node: TSNode): TSNode[] {
    return node ? node.namedChildren : [];
}

function firstOfType(node: TSNode, type: string): TSNode | null {
    return named(node).find((c: TSNode) => c.type === type) ?? null;
}

function makeNode(kind: ViewNode['kind'], props: Record<string, any> = {}, children: ViewNode[] = []): ViewNode {
    return { kind, props, modifiers: [], children };
}

/** Value arguments and trailing closures of a call_suffix */
interface CallArgs {
    args: Array<{ label: string | null; expr: TSNode }>;
    closures: Array<{ label: string | null; lambda: TSNode }>;
}

function callArgs(suffix: TSNode | null): CallArgs {
    const result: CallArgs = { args: [], closures: [] };
    if (!suffix) return result;
    let pendingLabel: string | null = null;
    for (const child of named(suffix)) {
        if (child.type === 'value_arguments') {
            for (const arg of named(child)) {
                if (arg.type !== 'value_argument') continue;
                const parts = named(arg);
                const labelNode = parts.find((p: TSNode) => p.type === 'value_argument_label');
                const expr = parts.find((p: TSNode) => p.type !== 'value_argument_label');
                if (!expr) continue;
                result.args.push({ label: labelNode ? labelNode.text : null, expr });
            }
        } else if (child.type === 'simple_identifier') {
            pendingLabel = child.text; // label of a following trailing closure
        } else if (child.type === 'lambda_literal') {
            result.closures.push({ label: pendingLabel, lambda: child });
            pendingLabel = null;
        }
    }
    return result;
}

function argNamed(call: CallArgs, label: string): TSNode | null {
    return call.args.find(a => a.label === label)?.expr ?? null;
}

function firstUnlabeled(call: CallArgs): TSNode | null {
    return call.args.find(a => a.label === null)?.expr ?? null;
}

function closureNamed(call: CallArgs, label: string | null): TSNode | null {
    return call.closures.find(c => c.label === label)?.lambda ?? null;
}

function lambdaStatements(lambda: TSNode | null): TSNode | null {
    return lambda ? firstOfType(lambda, 'statements') : null;
}

/** Parameter names declared by a closure (`{ item in ... }`) */
function lambdaParams(lambda: TSNode): string[] {
    const type = firstOfType(lambda, 'lambda_function_type');
    if (!type) return [];
    const names: string[] = [];
    const walk = (n: TSNode) => {
        if (n.type === 'lambda_parameter') {
            const id = firstOfType(n, 'simple_identifier');
            if (id) names.push(id.text);
            return;
        }
        named(n).forEach(walk);
    };
    walk(type);
    return names;
}

// ---------------------------------------------------------------------------
// Expression evaluation
// ---------------------------------------------------------------------------

function display(v: Value): string | null {
    switch (v.kind) {
        case 'string': return v.value;
        case 'number': return String(v.value);
        case 'bool': return String(v.value);
        case 'enum': return v.value;
        default: return null;
    }
}

function asBool(v: Value): boolean | null {
    return v.kind === 'bool' ? v.value : null;
}

function asNumber(v: Value): number | null {
    return v.kind === 'number' ? v.value : null;
}

function lookupVar(name: string, env: Env, ctx: Context, seen: Set<string>): Value {
    const key = name.replace(/^\$/, '');
    if (seen.has(key)) return UNKNOWN;
    const binding = env.lookup(key) ?? ctx.globals.lookup(key);
    if (!binding) return UNKNOWN;
    if (binding.value) return binding.value;
    if (binding.node) {
        seen.add(key);
        const v = evalExpr(binding.node, binding.env ?? ctx.globals, ctx, seen);
        seen.delete(key);
        return v;
    }
    return UNKNOWN;
}

function evalExpr(node: TSNode, env: Env, ctx: Context, seen: Set<string> = new Set()): Value {
    if (!node) return UNKNOWN;
    switch (node.type) {
        case 'line_string_literal':
        case 'multi_line_string_literal': {
            let text = '';
            for (const part of node.children) {
                if (part.type === 'line_str_text' || part.type === 'multi_line_str_text') text += part.text;
                else if (part.type === 'str_escaped_char') text += unescape(part.text);
                else if (part.type === 'interpolated_expression') {
                    const inner = named(part)[0];
                    const v = inner ? display(evalExpr(inner, env, ctx, seen)) : null;
                    text += v ?? '…';
                }
            }
            return { kind: 'string', value: text };
        }
        case 'integer_literal':
        case 'real_literal':
        case 'hex_literal': {
            const n = Number(node.text.replace(/_/g, ''));
            return isNaN(n) ? UNKNOWN : { kind: 'number', value: n };
        }
        case 'boolean_literal':
            return { kind: 'bool', value: node.text === 'true' };
        case 'nil':
            return UNKNOWN;
        case 'prefix_expression': {
            const text: string = node.text.trim();
            if (text.startsWith('.')) {
                const m = text.match(/^\.([A-Za-z_]\w*)/);
                return m ? { kind: 'enum', value: m[1] } : UNKNOWN;
            }
            const operand = named(node)[named(node).length - 1];
            if (text.startsWith('!')) {
                const b = asBool(evalExpr(operand, env, ctx, seen));
                return b === null ? UNKNOWN : { kind: 'bool', value: !b };
            }
            if (text.startsWith('-')) {
                const n = asNumber(evalExpr(operand, env, ctx, seen));
                return n === null ? UNKNOWN : { kind: 'number', value: -n };
            }
            return evalExpr(operand, env, ctx, seen);
        }
        case 'simple_identifier':
            return lookupVar(node.text, env, ctx, seen);
        case 'navigation_expression': {
            const target = named(node)[0];
            const suffix = firstOfType(node, 'navigation_suffix');
            const member = suffix ? firstOfType(suffix, 'simple_identifier')?.text : null;
            if (!member) return UNKNOWN;
            // Type.member (Color.red, Estado.activo)
            if (target?.type === 'simple_identifier' && /^[A-Z]/.test(target.text)) {
                return { kind: 'enum', value: member };
            }
            // `.red.opacity` style chains: keep the base member
            if (target?.type === 'prefix_expression' && target.text.startsWith('.')) {
                return evalExpr(target, env, ctx, seen);
            }
            if (member === 'count' || member === 'isEmpty') return UNKNOWN;
            // obj.prop -> look the property up by name anywhere in the file
            return lookupVar(member, new Env(null, null), ctx, seen);
        }
        case 'ternary_expression': {
            const [cond, a, b] = named(node);
            const c = asBool(evalExpr(cond, env, ctx, seen));
            return evalExpr(c === false ? b : a, env, ctx, seen);
        }
        case 'equality_expression':
        case 'comparison_expression': {
            const [lhs, rhs] = named(node);
            const op = node.children.find((c: TSNode) => !c.isNamed)?.text;
            const l = evalExpr(lhs, env, ctx, seen);
            const r = evalExpr(rhs, env, ctx, seen);
            if (l.kind === 'unknown' || r.kind === 'unknown') return UNKNOWN;
            const lv = (l as any).value;
            const rv = (r as any).value;
            switch (op) {
                case '==': return { kind: 'bool', value: lv === rv };
                case '!=': return { kind: 'bool', value: lv !== rv };
                case '<': return { kind: 'bool', value: lv < rv };
                case '>': return { kind: 'bool', value: lv > rv };
                case '<=': return { kind: 'bool', value: lv <= rv };
                case '>=': return { kind: 'bool', value: lv >= rv };
            }
            return UNKNOWN;
        }
        case 'conjunction_expression':
        case 'disjunction_expression': {
            const [lhs, rhs] = named(node);
            const l = asBool(evalExpr(lhs, env, ctx, seen));
            const r = asBool(evalExpr(rhs, env, ctx, seen));
            if (node.type === 'conjunction_expression') {
                if (l === false || r === false) return { kind: 'bool', value: false };
                return l === true && r === true ? { kind: 'bool', value: true } : UNKNOWN;
            }
            if (l === true || r === true) return { kind: 'bool', value: true };
            return l === false && r === false ? { kind: 'bool', value: false } : UNKNOWN;
        }
        case 'parenthesized_expression':
        case 'tuple_expression':
            return named(node).length === 1 ? evalExpr(named(node)[0], env, ctx, seen) : UNKNOWN;
        case 'array_literal':
            return { kind: 'array', value: named(node).map((n: TSNode) => evalExpr(n, env, ctx, seen)) };
        case 'call_expression': {
            // `.degrees(45)`, `URL(string: "…")`, `String(x)`: value of the only argument
            const call = callArgs(firstOfType(node, 'call_suffix'));
            if (call.args.length === 1 && call.closures.length === 0) {
                return evalExpr(call.args[0].expr, env, ctx, seen);
            }
            return UNKNOWN;
        }
    }
    return UNKNOWN;
}

function unescape(seq: string): string {
    switch (seq) {
        case '\\n': return '\n';
        case '\\t': return '\t';
        case '\\"': return '"';
        case '\\\\': return '\\';
        default: return seq.replace(/^\\/, '');
    }
}

/** Text to show for an expression that cannot be evaluated (e.g. `$0.titulo` -> "titulo") */
function placeholderFor(node: TSNode): string {
    const ids = (node.text as string).match(/[A-Za-z_][A-Za-z0-9_]*/g);
    return ids ? ids[ids.length - 1] : '…';
}

function textOf(node: TSNode | null, env: Env, ctx: Context): string | null {
    if (!node) return null;
    return display(evalExpr(node, env, ctx)) ?? placeholderFor(node);
}

/** Member name of `.title`, `Color.red`, `.subheadline.bold()`… */
function memberName(node: TSNode | null, env: Env, ctx: Context): string | null {
    if (!node) return null;
    if (node.type === 'call_expression' || node.type === 'navigation_expression') {
        const target = named(node)[0];
        const inner = target?.type === 'navigation_expression' && node.type === 'call_expression'
            ? named(target)[0]
            : null;
        if (inner && inner.type === 'prefix_expression') return memberName(inner, env, ctx);
    }
    const v = evalExpr(node, env, ctx);
    return v.kind === 'enum' || v.kind === 'string' ? v.value : null;
}

const COLOR_ALIASES: Record<string, string | null> = {
    secondary: 'gray',
    accentColor: 'blue',
    accent: 'blue',
    primary: null,
};

function colorOf(node: TSNode | null, env: Env, ctx: Context): string | null {
    const name = memberName(node, env, ctx);
    if (!name) return null;
    return name in COLOR_ALIASES ? COLOR_ALIASES[name] : name;
}

// ---------------------------------------------------------------------------
// File structure (structs, functions, properties)
// ---------------------------------------------------------------------------

function isViewDeclaration(decl: TSNode): boolean {
    return named(decl).some((c: TSNode) =>
        c.type === 'inheritance_specifier' && /\bView\b/.test(c.text) && !/PreviewProvider/.test(c.text));
}

function declName(decl: TSNode): string | null {
    return firstOfType(decl, 'type_identifier')?.text ?? null;
}

/** Name and initializer of a property_declaration */
function propertyParts(prop: TSNode): { name: string | null; init: TSNode | null; computed: TSNode | null } {
    const pattern = firstOfType(prop, 'pattern');
    const name = pattern ? (firstOfType(pattern, 'simple_identifier')?.text ?? pattern.text) : null;
    const computed = firstOfType(prop, 'computed_property');
    const skip = new Set(['modifiers', 'value_binding_pattern', 'pattern', 'type_annotation', 'computed_property', 'property_behavior_modifier']);
    const init = named(prop).filter((c: TSNode) => !skip.has(c.type)).pop() ?? null;
    return { name, init, computed };
}

function computedStatements(computed: TSNode): TSNode | null {
    return firstOfType(computed, 'statements')
        ?? firstOfType(firstOfType(computed, 'getter') ?? computed, 'statements');
}

const TYPE_NODES = new Set([
    'user_type', 'opaque_type', 'optional_type', 'array_type', 'dictionary_type', 'tuple_type',
    'function_type', 'existential_type', 'type_parameters', 'type_constraints', 'modifiers',
    'attribute', 'function_body', 'parameter', 'simple_identifier', 'throws', 'async',
]);

function functionInfo(fn: TSNode): { name: string; params: Param[]; body: TSNode | null } | null {
    const nameNode = named(fn).find((c: TSNode) => c.type === 'simple_identifier');
    if (!nameNode) return null;
    const params: Param[] = [];
    for (const child of named(fn)) {
        if (child.type === 'parameter') {
            const ids = named(child).filter((c: TSNode) => c.type === 'simple_identifier').map((c: TSNode) => c.text);
            const label = ids.length > 1 ? (ids[0] === '_' ? null : ids[0]) : ids[0];
            params.push({ label, name: ids[ids.length - 1] });
        } else if (params.length > 0 && !TYPE_NODES.has(child.type)) {
            params[params.length - 1].defaultValue = child; // `= default` follows its parameter
        }
    }
    const body = firstOfType(firstOfType(fn, 'function_body'), 'statements');
    return { name: nameNode.text, params, body };
}

function collectFile(root: TSNode): { structs: Map<string, StructInfo>; globals: Env; mainView: StructInfo | null } {
    const structs = new Map<string, StructInfo>();
    const globals = new Env(null, null);
    let mainView: StructInfo | null = null;

    const visit = (node: TSNode) => {
        if (node.type === 'class_declaration') {
            const name = declName(node);
            const body = firstOfType(node, 'class_body');
            if (name && body) {
                const info: StructInfo = {
                    name,
                    isView: isViewDeclaration(node),
                    stored: [],
                    funcs: new Map(),
                    viewProps: new Map(),
                };
                for (const member of named(body)) {
                    if (member.type === 'property_declaration') {
                        const { name: prop, init, computed } = propertyParts(member);
                        if (!prop) continue;
                        if (computed) {
                            const stmts = computedStatements(computed);
                            if (stmts) info.viewProps.set(prop, stmts);
                        } else {
                            info.stored.push({ name: prop, defaultValue: init ?? undefined });
                            if (init && !globals.lookup(prop)) globals.set(prop, { node: init, env: globals });
                        }
                    } else if (member.type === 'function_declaration') {
                        const fn = functionInfo(member);
                        if (fn) info.funcs.set(fn.name, { params: fn.params, body: fn.body });
                    }
                }
                structs.set(name, info);
                if (info.isView && !mainView) mainView = info;
            }
        }
        for (const child of named(node)) visit(child);
    };
    visit(root);
    return { structs, globals, mainView };
}

/** Environment for a struct instance: stored properties bound to call arguments or defaults */
function structEnv(info: StructInfo, call: CallArgs | null, callerEnv: Env): Env {
    const env = new Env(null, info);
    for (const prop of info.stored) {
        const idx = call ? call.args.findIndex(a => a.label === prop.name) : -1;
        if (idx >= 0) {
            env.set(prop.name, { node: call!.args[idx].expr, env: callerEnv });
        } else if (prop.defaultValue) {
            env.set(prop.name, { node: prop.defaultValue, env });
        } else {
            env.set(prop.name, { value: UNKNOWN });
        }
    }
    return env;
}

// ---------------------------------------------------------------------------
// Statements -> views
// ---------------------------------------------------------------------------

function viewsFromStatements(statements: TSNode | null, parentEnv: Env, ctx: Context): ViewNode[] {
    if (!statements) return [];
    const env = parentEnv.child();
    const views: ViewNode[] = [];
    for (const stmt of named(statements)) {
        try {
            views.push(...viewsFromStatement(stmt, env, ctx));
        } catch (error) {
            console.warn('SwiftUI CrossPreview: skipped statement', stmt.text.slice(0, 60), error);
        }
    }
    return views;
}

function viewsFromStatement(stmt: TSNode, env: Env, ctx: Context): ViewNode[] {
    switch (stmt.type) {
        case 'property_declaration': {
            const { name, init } = propertyParts(stmt);
            if (name) env.set(name, init ? { node: init, env } : { value: UNKNOWN });
            return [];
        }
        case 'if_statement':
            return viewsFromIf(stmt, env, ctx);
        case 'switch_statement':
            return viewsFromSwitch(stmt, env, ctx);
        case 'control_transfer_statement': {
            // `return Text("…")`
            const value = named(stmt)[0];
            return value ? viewsFromStatement(value, env, ctx) : [];
        }
        case 'for_statement':
        case 'guard_statement':
        case 'assignment':
        case 'comment':
        case 'multiline_comment':
            return [];
        default: {
            const view = viewFromExpression(stmt, env, ctx);
            return view ? [view] : [];
        }
    }
}

function viewsFromIf(node: TSNode, env: Env, ctx: Context): ViewNode[] {
    const parts = named(node);
    const thenIndex = parts.findIndex((c: TSNode) => c.type === 'statements');
    const conditions = parts.slice(0, thenIndex === -1 ? parts.length : thenIndex);
    const thenBranch = thenIndex >= 0 ? parts[thenIndex] : null;
    const elseBranch = thenIndex >= 0 ? parts.slice(thenIndex + 1).find((c: TSNode) => c.type === 'statements' || c.type === 'if_statement') : null;

    // All conditions must hold; `if let` bindings and unknown values count as true
    let result: boolean | null = true;
    const branchEnv = env.child();
    for (const cond of conditions) {
        if (cond.type === 'value_binding_pattern' || cond.type === 'if_let_binding' || cond.type === 'pattern') {
            continue;
        }
        const v = asBool(evalExpr(cond, env, ctx));
        if (v === false) { result = false; break; }
        if (v === null) result = result === true ? null : result;
    }

    if (result === false) {
        if (!elseBranch) return [];
        return elseBranch.type === 'if_statement'
            ? viewsFromIf(elseBranch, env, ctx)
            : viewsFromStatements(elseBranch, env, ctx);
    }
    return viewsFromStatements(thenBranch, branchEnv, ctx);
}

function viewsFromSwitch(node: TSNode, env: Env, ctx: Context): ViewNode[] {
    const parts = named(node);
    const subject = parts[0];
    const entries = parts.filter((c: TSNode) => c.type === 'switch_entry');
    if (entries.length === 0) return [];

    const value = evalExpr(subject, env, ctx);
    const target = display(value);
    let chosen: TSNode | null = null;
    if (target !== null) {
        for (const entry of entries) {
            const patterns = named(entry).filter((c: TSNode) => c.type === 'switch_pattern');
            const hit = patterns.some((p: TSNode) => {
                const text = (p.text as string).replace(/^\s*(let|var)\s+/, '').trim();
                if (value.kind === 'enum') {
                    const m = text.match(/^(?:[A-Z]\w*)?\.?([A-Za-z_]\w*)/);
                    return !!m && m[1] === target;
                }
                const lit = text.replace(/^"(.*)"$/, '$1');
                return lit === target;
            });
            if (hit) { chosen = entry; break; }
        }
        chosen = chosen ?? entries.find((e: TSNode) => !!firstOfType(e, 'default_keyword')) ?? null;
    }
    chosen = chosen ?? entries[0];
    return viewsFromStatements(firstOfType(chosen, 'statements'), env, ctx);
}

// ---------------------------------------------------------------------------
// Expressions -> views
// ---------------------------------------------------------------------------

function viewFromExpression(node: TSNode, env: Env, ctx: Context): ViewNode | null {
    // Peel off the modifier chain: base.mod1(...).mod2(...)
    const mods: Array<{ name: string; suffix: TSNode | null }> = [];
    let base = node;
    while (base.type === 'call_expression') {
        const callee = named(base)[0];
        if (callee?.type !== 'navigation_expression') break;
        const target = named(callee)[0];
        const navSuffix = firstOfType(callee, 'navigation_suffix');
        const name = navSuffix ? firstOfType(navSuffix, 'simple_identifier')?.text : null;
        // `Type.factory(...)` is a value, not a modifier
        if (!name || !target || (target.type === 'simple_identifier' && /^[A-Z]/.test(target.text))) break;
        mods.unshift({ name, suffix: firstOfType(base, 'call_suffix') });
        base = target;
    }

    const view = viewFromBase(base, env, ctx);
    if (!view) return null;
    for (const mod of mods) applyModifier(view, mod.name, callArgs(mod.suffix), env, ctx);
    return view;
}

function group(views: ViewNode[]): ViewNode | null {
    if (views.length === 0) return null;
    if (views.length === 1) return views[0];
    return makeNode('Group', {}, views);
}

function viewFromBase(node: TSNode, env: Env, ctx: Context): ViewNode | null {
    switch (node.type) {
        case 'call_expression': {
            const callee = named(node)[0];
            const call = callArgs(firstOfType(node, 'call_suffix'));
            if (callee?.type === 'simple_identifier') return viewFromCall(callee.text, call, env, ctx);
            if (callee?.type === 'navigation_expression') {
                // `Color.red.opacity(…)` handled as modifier; `Image.init(…)` etc.
                const target = named(callee)[0];
                if (target?.type === 'simple_identifier') return viewFromCall(target.text, call, env, ctx);
            }
            return null;
        }
        case 'navigation_expression': {
            // `Color.red` (or `Color.accentColor`) used as a view
            const target = named(node)[0];
            if (target?.type === 'simple_identifier' && target.text === 'Color') {
                const fill = colorOf(node, env, ctx);
                const view = makeNode('Rectangle');
                if (fill) view.modifiers.push({ name: 'fill', args: { color: fill } });
                return view;
            }
            return null;
        }
        case 'simple_identifier': {
            // A computed view property of the current struct (`cabecera`)
            const stmts = env.owner?.viewProps.get(node.text);
            if (stmts) return inline(`${env.owner!.name}.${node.text}`, ctx, () =>
                group(viewsFromStatements(stmts, structScope(env), ctx)));
            if (/^[A-Z]/.test(node.text)) return viewFromCall(node.text, { args: [], closures: [] }, env, ctx);
            return null;
        }
        case 'if_statement':
            return group(viewsFromIf(node, env, ctx));
        case 'switch_statement':
            return group(viewsFromSwitch(node, env, ctx));
        case 'ternary_expression': {
            const [cond, a, b] = named(node);
            const c = asBool(evalExpr(cond, env, ctx));
            return viewFromExpression(c === false ? b : a, env, ctx);
        }
        case 'parenthesized_expression':
            return named(node).length === 1 ? viewFromExpression(named(node)[0], env, ctx) : null;
    }
    return null;
}

/** Environment of the struct that owns `env` (for helpers and view properties) */
function structScope(env: Env): Env {
    let e: Env = env;
    while (e.parent && e.parent.owner === env.owner) e = e.parent;
    return e;
}

function inline(key: string, ctx: Context, build: () => ViewNode | null): ViewNode | null {
    if (ctx.depth >= MAX_DEPTH || ctx.inlining.has(key)) return null;
    ctx.depth++;
    ctx.inlining.add(key);
    try {
        return build();
    } finally {
        ctx.depth--;
        ctx.inlining.delete(key);
    }
}

function closureViews(lambda: TSNode | null, env: Env, ctx: Context): ViewNode[] {
    return viewsFromStatements(lambdaStatements(lambda), env, ctx);
}

/** First text found in a label closure (`label: { VStack { Text("…") … } }`) */
function firstText(views: ViewNode[]): string | null {
    for (const v of views) {
        if (v.kind === 'Text' && v.props.text) return v.props.text;
        if (v.kind === 'Label' && v.props.title) return v.props.title;
        const inner = firstText(v.children);
        if (inner) return inner;
    }
    return null;
}

const STACKS = new Set(['VStack', 'HStack', 'ZStack', 'LazyVStack', 'LazyHStack']);
const CONTAINERS: Record<string, ViewNode['kind']> = {
    List: 'List', Form: 'Form', ScrollView: 'ScrollView', Group: 'Group', GeometryReader: 'GeometryReader',
    Grid: 'Grid', LazyVGrid: 'Grid', LazyHGrid: 'Grid', GridRow: 'HStack', NavigationView: 'NavigationView',
    NavigationStack: 'NavigationStack', TabView: 'TabView', ControlGroup: 'HStack', ViewThatFits: 'Group',
};
const SHAPES: Record<string, ViewNode['kind']> = {
    Rectangle: 'Rectangle', Circle: 'Circle', Capsule: 'Capsule', Ellipse: 'Ellipse',
    RoundedRectangle: 'RoundedRectangle', UnevenRoundedRectangle: 'RoundedRectangle',
};

function viewFromCall(name: string, call: CallArgs, env: Env, ctx: Context): ViewNode | null {
    const arg0 = firstUnlabeled(call);
    const content = closureNamed(call, null) ?? closureNamed(call, 'content');

    if (STACKS.has(name)) {
        const props: Record<string, any> = {};
        const alignment = memberName(argNamed(call, 'alignment'), env, ctx);
        const spacing = asNumber(evalExpr(argNamed(call, 'spacing'), env, ctx));
        if (alignment) props.alignment = alignment;
        if (spacing !== null) props.spacing = spacing;
        return makeNode(name as ViewNode['kind'], props, closureViews(content, env, ctx));
    }

    if (name in CONTAINERS) {
        const kind = CONTAINERS[name];
        let children = closureViews(content, env, ctx);
        // List(items) { item in … } behaves like ForEach
        if (name === 'List' && arg0 && content) {
            children = [forEachNode(arg0, content, env, ctx)];
        }
        const view = makeNode(kind, {}, children);
        if (kind === 'Form' || kind === 'List') markRowButtons(children);
        if (kind === 'NavigationStack' || kind === 'NavigationView') {
            const title = findNavigationTitle(children);
            if (title) view.props.title = title;
        }
        return view;
    }

    if (name in SHAPES) {
        const props: Record<string, any> = {};
        const radius = asNumber(evalExpr(argNamed(call, 'cornerRadius'), env, ctx));
        if (radius !== null) props.cornerRadius = radius;
        return makeNode(SHAPES[name], props);
    }

    switch (name) {
        case 'Text': {
            const text = textOf(arg0 ?? argNamed(call, 'verbatim'), env, ctx) ?? '';
            return makeNode('Text', { text });
        }
        case 'Image': {
            const systemName = argNamed(call, 'systemName');
            const props: Record<string, any> = { name: textOf(systemName ?? arg0, env, ctx) ?? 'Image' };
            if (systemName) props.systemName = true;
            return makeNode('Image', props);
        }
        case 'Label': {
            const titleClosure = closureNamed(call, 'title') ?? closureNamed(call, null);
            const title = arg0 ? textOf(arg0, env, ctx) : firstText(closureViews(titleClosure, env, ctx));
            const icon = textOf(argNamed(call, 'systemImage') ?? argNamed(call, 'image'), env, ctx);
            return makeNode('Label', { title: title ?? '', systemImage: icon ?? '' });
        }
        case 'Button': {
            let children: ViewNode[];
            const labelClosure = closureNamed(call, 'label');
            if (arg0 && arg0.type !== 'lambda_literal') {
                children = [makeNode('Text', { text: textOf(arg0, env, ctx) ?? 'Button' })];
            } else if (labelClosure) {
                children = closureViews(labelClosure, env, ctx);
            } else if (argNamed(call, 'action') && content) {
                children = closureViews(content, env, ctx);
            } else {
                children = [];
            }
            const props: Record<string, any> = { action: 'action' };
            if (memberName(argNamed(call, 'role'), env, ctx) === 'destructive') props.role = 'destructive';
            return makeNode('Button', props, children);
        }
        case 'Toggle': {
            const label = arg0
                ? textOf(arg0, env, ctx)
                : firstText(closureViews(closureNamed(call, 'label') ?? content, env, ctx));
            const isOn = asBool(evalExpr(argNamed(call, 'isOn'), env, ctx));
            return makeNode('Toggle', { label: label ?? 'Toggle', isOn: isOn ?? false });
        }
        case 'Picker': {
            const label = arg0
                ? textOf(arg0, env, ctx)
                : firstText(closureViews(closureNamed(call, 'label'), env, ctx));
            return makeNode('Picker', { label: label ?? 'Picker' }, pickerOptions(closureViews(content, env, ctx)));
        }
        case 'TextField':
        case 'SecureField':
            return makeNode(name, { placeholder: textOf(arg0, env, ctx) ?? '' });
        case 'TextEditor':
            return makeNode('TextEditor', { text: '' });
        case 'Slider': {
            const range = rangeOf(argNamed(call, 'in'), env, ctx);
            const value = asNumber(evalExpr(argNamed(call, 'value'), env, ctx));
            const props: Record<string, any> = {};
            if (range) props.range = [range.start, range.end];
            if (value !== null) props.value = value;
            return makeNode('Slider', props);
        }
        case 'Stepper': {
            const value = asNumber(evalExpr(argNamed(call, 'value'), env, ctx));
            return makeNode('Stepper', { label: textOf(arg0, env, ctx) ?? 'Stepper', value: value ?? 0 });
        }
        case 'DatePicker':
        case 'ColorPicker':
            return makeNode(name, { label: textOf(arg0, env, ctx) ?? name });
        case 'ProgressView': {
            const value = asNumber(evalExpr(argNamed(call, 'value'), env, ctx));
            return makeNode('ProgressView', value !== null ? { value } : {});
        }
        case 'Link':
            return makeNode('Link', {
                title: textOf(arg0, env, ctx) ?? firstText(closureViews(closureNamed(call, 'label') ?? content, env, ctx)) ?? 'Link',
                destination: textOf(argNamed(call, 'destination'), env, ctx) ?? '',
            });
        case 'Menu': {
            const label = arg0
                ? textOf(arg0, env, ctx)
                : firstText(closureViews(closureNamed(call, 'label'), env, ctx));
            return makeNode('Menu', { label: label ?? 'Menu' }, closureViews(content, env, ctx));
        }
        case 'NavigationLink': {
            let label: string | null = null;
            if (arg0) label = textOf(arg0, env, ctx);
            else if (closureNamed(call, 'label')) label = firstText(closureViews(closureNamed(call, 'label'), env, ctx));
            else if (content) label = firstText(closureViews(content, env, ctx));
            return makeNode('NavigationLink', { label: label ?? 'Link', destination: '' });
        }
        case 'NavigationSplitView': {
            const sidebar = group(closureViews(closureNamed(call, 'sidebar') ?? content, env, ctx));
            const detail = group(closureViews(closureNamed(call, 'detail'), env, ctx));
            return makeNode('NavigationSplitView', { sidebar, detail });
        }
        case 'DisclosureGroup': {
            const label = arg0
                ? textOf(arg0, env, ctx)
                : firstText(closureViews(closureNamed(call, 'label'), env, ctx));
            return makeNode('DisclosureGroup', { label: label ?? 'Disclosure' }, closureViews(content, env, ctx));
        }
        case 'Section': {
            const header = arg0
                ? textOf(arg0, env, ctx)
                : firstText(closureViews(closureNamed(call, 'header'), env, ctx))
                  ?? firstText(argNamed(call, 'header') ? [viewFromExpression(argNamed(call, 'header'), env, ctx)!].filter(Boolean) : []);
            const props: Record<string, any> = {};
            if (header) props.header = header;
            const footer = firstText(closureViews(closureNamed(call, 'footer'), env, ctx));
            const children = closureViews(content, env, ctx);
            if (footer) children.push(makeNode('Text', { text: footer }, []));
            return makeNode('Section', props, children);
        }
        case 'ForEach':
            return arg0 && content ? forEachNode(arg0, content, env, ctx) : null;
        case 'LinearGradient':
        case 'RadialGradient':
        case 'AngularGradient': {
            const colors = gradientColors(call, env, ctx);
            const props: Record<string, any> = { colors };
            const start = memberName(argNamed(call, 'startPoint'), env, ctx);
            const end = memberName(argNamed(call, 'endPoint'), env, ctx);
            if (start) props.startPoint = start;
            if (end) props.endPoint = end;
            return makeNode(name === 'LinearGradient' ? 'LinearGradient' : 'RadialGradient', props);
        }
        case 'AsyncImage':
            return makeNode('AsyncImage', { url: textOf(argNamed(call, 'url'), env, ctx) ?? '' });
        case 'Color': {
            const view = makeNode('Rectangle');
            const fill = colorOf(arg0, env, ctx);
            if (fill) view.modifiers.push({ name: 'fill', args: { color: fill } });
            return view;
        }
        case 'Spacer':
        case 'Divider':
            return makeNode(name);
        case 'EmptyView':
        case 'AnyView':
            return name === 'AnyView' && arg0 ? viewFromExpression(arg0, env, ctx) : null;
    }

    // View struct declared in this file -> inline its body
    const struct = ctx.structs.get(name);
    if (struct && struct.isView) {
        const bodyStmts = struct.viewProps.get('body');
        if (bodyStmts) {
            return inline(`struct:${name}`, ctx, () => {
                const sEnv = structEnv(struct, call, env);
                return group(viewsFromStatements(bodyStmts, sEnv, ctx));
            });
        }
    }

    // Helper function of the current struct (`campo("…", …)`)
    const fn = env.owner?.funcs.get(name);
    if (fn && fn.body) {
        return inline(`${env.owner!.name}.${name}`, ctx, () => {
            const fEnv = structScope(env).child();
            let positional = 0;
            const unlabeled = call.args.filter(a => a.label === null);
            for (const p of fn.params) {
                const arg = p.label === null
                    ? unlabeled[positional++]?.expr
                    : call.args.find(a => a.label === p.label)?.expr;
                if (arg) fEnv.set(p.name, { node: arg, env });
                else if (p.defaultValue) fEnv.set(p.name, { node: p.defaultValue, env: fEnv });
                else fEnv.set(p.name, { value: UNKNOWN });
            }
            return group(viewsFromStatements(fn.body, fEnv, ctx));
        });
    }

    // View from another file: show a labelled placeholder
    if (/^[A-Z]/.test(name)) {
        const text = arg0 ? display(evalExpr(arg0, env, ctx)) : null;
        const props: Record<string, any> = { name };
        if (text) props.text = text;
        return makeNode('Custom', props, closureViews(content, env, ctx));
    }
    return null;
}

/** Buttons directly inside a Form/List are drawn as tinted rows, like SwiftUI does */
function markRowButtons(views: ViewNode[]): void {
    for (const v of views) {
        if (v.kind === 'Button') {
            if (!v.props.style) v.props.style = 'row';
            continue;
        }
        markRowButtons(v.children);
        if (v.kind === 'ForEach' && v.props.rowTemplate) markRowButtons([v.props.rowTemplate]);
    }
}

function findNavigationTitle(views: ViewNode[]): string | null {
    for (const v of views) {
        const mod = v.modifiers.find(m => m.name === 'navigationTitle');
        if (mod?.args.title) return mod.args.title;
    }
    for (const v of views) {
        const inner = findNavigationTitle(v.children);
        if (inner) return inner;
    }
    return null;
}

function rangeOf(node: TSNode | null, env: Env, ctx: Context): { start: number; end: number } | null {
    if (!node || node.type !== 'range_expression') return null;
    const [lo, hi] = named(node);
    const start = asNumber(evalExpr(lo, env, ctx));
    const end = asNumber(evalExpr(hi, env, ctx));
    if (start === null || end === null) return null;
    const inclusive = (node.text as string).includes('...');
    return { start, end: inclusive ? end + 1 : end };
}

const SAMPLE_ROWS = 3;

function forEachNode(source: TSNode, lambda: TSNode, env: Env, ctx: Context): ViewNode {
    const props: Record<string, any> = {};
    const rowEnv = env.child();
    const params = lambdaParams(lambda);
    const range = rangeOf(source, env, ctx);
    const items = evalExpr(source, env, ctx);

    if (range) {
        props.forEachRange = { start: range.start, end: Math.min(range.end, range.start + 50) };
    } else if (items.kind === 'array' && items.value.length > 0) {
        props.forEachItems = items.value.slice(0, 50).map(v => display(v) ?? '');
        if (params[0]) rowEnv.set(params[0], { value: items.value[0] });
    } else {
        props.forEachItems = Array.from({ length: SAMPLE_ROWS }, (_, i) => i);
    }
    for (const p of params) if (!rowEnv.lookup(p) || rowEnv.lookup(p) === env.lookup(p)) rowEnv.set(p, { value: UNKNOWN });

    const row = group(closureViews(lambda, rowEnv, ctx));
    if (row) props.rowTemplate = row;
    return makeNode('ForEach', props);
}

function forEachCount(node: ViewNode): number {
    if (node.props.forEachRange) return node.props.forEachRange.end - node.props.forEachRange.start;
    if (node.props.forEachItems) return node.props.forEachItems.length;
    return SAMPLE_ROWS;
}

/** Picker options as a flat list of Text nodes (ForEach rows expanded) */
function pickerOptions(views: ViewNode[]): ViewNode[] {
    const options: ViewNode[] = [];
    for (const v of views) {
        if (v.kind === 'Text' || v.kind === 'Label') {
            options.push(v.kind === 'Text' ? v : makeNode('Text', { text: v.props.title }));
        } else if (v.kind === 'ForEach' && v.props.rowTemplate) {
            const n = Math.min(forEachCount(v), 10);
            const items: any[] = v.props.forEachItems ?? [];
            for (let i = 0; i < n; i++) {
                const text = firstText([v.props.rowTemplate]) ?? String(items[i] ?? i);
                options.push(makeNode('Text', { text: items.length && typeof items[i] === 'string' && items[i] ? items[i] : text }));
            }
        } else {
            options.push(...pickerOptions(v.children));
        }
    }
    return options;
}

function gradientColors(call: CallArgs, env: Env, ctx: Context): string[] {
    let list = argNamed(call, 'colors');
    const gradient = argNamed(call, 'gradient');
    if (!list && gradient?.type === 'call_expression') {
        list = argNamed(callArgs(firstOfType(gradient, 'call_suffix')), 'colors');
    }
    if (list?.type !== 'array_literal') return ['blue', 'purple'];
    const colors = named(list).map((c: TSNode) => colorOf(c, env, ctx)).filter((c: string | null): c is string => !!c);
    return colors.length ? colors : ['blue', 'purple'];
}

// ---------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------

const FONT_STYLES = new Set(['largeTitle', 'title', 'title2', 'title3', 'headline', 'subheadline', 'body', 'callout', 'footnote', 'caption', 'caption2']);
const MATERIALS: Record<string, string> = {
    ultraThinMaterial: 'ultrathin', thinMaterial: 'thin', regularMaterial: 'regular',
    thickMaterial: 'thick', ultraThickMaterial: 'ultrathick', bar: 'regular',
};

function shapeName(node: TSNode | null): string | null {
    if (!node) return null;
    const text: string = node.text;
    if (/^\.?Circle\b|^\.circle\b/.test(text)) return 'circle';
    if (/^\.?Capsule\b|^\.capsule\b/.test(text)) return 'capsule';
    if (/RoundedRectangle|^\.rect\b/.test(text)) return 'roundedRectangle';
    return null;
}

function numArg(node: TSNode | null, env: Env, ctx: Context): number | null {
    return node ? asNumber(evalExpr(node, env, ctx)) : null;
}

function applyModifier(view: ViewNode, name: string, call: CallArgs, env: Env, ctx: Context): void {
    const arg0 = call.args[0]?.expr ?? null;
    const args: Record<string, any> = {};
    const push = (n: string, a: Record<string, any> = {}) => view.modifiers.push({ name: n, args: a } as Modifier);

    switch (name) {
        case 'padding': {
            const nums = call.args.map(a => numArg(a.expr, env, ctx)).filter((n): n is number => n !== null);
            push('padding', { all: nums.length ? nums[nums.length - 1] : 16 });
            return;
        }
        case 'font': {
            const text: string = arg0?.text ?? '';
            const member = memberName(arg0, env, ctx);
            let style = member && FONT_STYLES.has(member) ? member : 'body';
            const size = text.match(/size:\s*([\d.]+)/);
            if (size) {
                const s = parseFloat(size[1]);
                style = s >= 26 ? 'largeTitle' : s >= 21 ? 'title' : s >= 19 ? 'title2' : s >= 17 ? 'title3' : s >= 15 ? 'body' : s >= 13 ? 'subheadline' : 'footnote';
            }
            push('font', { style });
            if (/\.bold\(\)/.test(text)) push('bold');
            if (/\.italic\(\)/.test(text)) push('italic');
            if (/weight:\s*\.(\w+)|\.weight\(\.(\w+)\)/.test(text)) {
                const w = text.match(/weight:\s*\.(\w+)|\.weight\(\.(\w+)\)/)!;
                push('fontWeight', { weight: w[1] ?? w[2] });
            }
            return;
        }
        case 'fontWeight': {
            const weight = memberName(arg0, env, ctx);
            if (weight) push('fontWeight', { weight });
            return;
        }
        case 'foregroundColor':
        case 'foregroundStyle':
        case 'tint':
        case 'accentColor': {
            const color = colorOf(arg0, env, ctx);
            if (color) push(name === 'accentColor' ? 'tint' : name, { color });
            return;
        }
        case 'background': {
            const member = memberName(arg0, env, ctx);
            if (member && member in MATERIALS) push('background', { material: MATERIALS[member] });
            else {
                const color = colorOf(arg0, env, ctx);
                if (color) push('background', { color });
            }
            return;
        }
        case 'frame': {
            const width = numArg(argNamed(call, 'width'), env, ctx);
            const height = numArg(argNamed(call, 'height'), env, ctx);
            if (width !== null) args.width = width;
            if (height !== null) args.height = height;
            push('frame', args);
            return;
        }
        case 'cornerRadius':
        case 'blur': {
            const radius = numArg(argNamed(call, 'radius') ?? arg0, env, ctx);
            if (radius !== null) push(name, { radius });
            return;
        }
        case 'shadow': {
            const radius = numArg(argNamed(call, 'radius'), env, ctx);
            push('shadow', radius !== null ? { radius } : {});
            return;
        }
        case 'opacity': {
            const value = numArg(arg0, env, ctx);
            if (value !== null) push('opacity', { value });
            return;
        }
        case 'multilineTextAlignment': {
            const alignment = memberName(arg0, env, ctx);
            if (alignment) push(name, { alignment });
            return;
        }
        case 'lineLimit': {
            const lines = numArg(arg0, env, ctx);
            if (lines !== null) push(name, { lines });
            return;
        }
        case 'rotationEffect':
        case 'hueRotation': {
            const text: string = arg0?.text ?? '';
            const value = numArg(arg0, env, ctx);
            if (value !== null) push(name, text.includes('radians') ? { radians: value } : { degrees: value });
            return;
        }
        case 'scaleEffect': {
            const scale = numArg(arg0, env, ctx);
            push(name, scale !== null ? { scale } : {});
            return;
        }
        case 'offset':
        case 'position': {
            const x = numArg(argNamed(call, 'x'), env, ctx);
            const y = numArg(argNamed(call, 'y'), env, ctx);
            if (x !== null) args.x = x;
            if (y !== null) args.y = y;
            push(name, args);
            return;
        }
        case 'border': {
            const color = colorOf(arg0, env, ctx);
            const width = numArg(argNamed(call, 'width'), env, ctx);
            if (color) args.color = color;
            if (width !== null) args.width = width;
            push(name, args);
            return;
        }
        case 'fill': {
            const color = colorOf(arg0, env, ctx);
            if (color) push('fill', { color });
            return;
        }
        case 'stroke':
        case 'strokeBorder': {
            const color = colorOf(arg0, env, ctx);
            const lineWidth = numArg(argNamed(call, 'lineWidth'), env, ctx);
            if (color) push('stroke', lineWidth !== null ? { color, lineWidth } : { color });
            return;
        }
        case 'disabled': {
            const isDisabled = asBool(evalExpr(arg0, env, ctx));
            push('disabled', { isDisabled: isDisabled ?? false });
            return;
        }
        case 'aspectRatio': {
            const ratio = numArg(arg0 && !argNamed(call, 'contentMode') || call.args[0]?.label === null ? arg0 : null, env, ctx);
            const contentMode = memberName(argNamed(call, 'contentMode'), env, ctx);
            if (ratio !== null) args.ratio = ratio;
            if (contentMode) args.contentMode = contentMode;
            push(name, args);
            return;
        }
        case 'clipShape':
        case 'mask': {
            const shape = shapeName(arg0);
            if (shape) push(name, { shape });
            return;
        }
        case 'brightness':
        case 'contrast':
        case 'saturation':
        case 'kerning':
        case 'tracking': {
            const amount = numArg(arg0, env, ctx);
            if (amount !== null) push(name, { amount });
            return;
        }
        case 'baselineOffset': {
            const offset = numArg(arg0, env, ctx);
            if (offset !== null) push(name, { offset });
            return;
        }
        case 'overlay': {
            const contentClosure = closureNamed(call, null) ?? closureNamed(call, 'content');
            const content = contentClosure
                ? group(closureViews(contentClosure, env, ctx))
                : arg0 ? viewFromExpression(arg0, env, ctx) : null;
            if (content) push('overlay', { content });
            return;
        }
        case 'navigationTitle': {
            const title = textOf(arg0, env, ctx);
            push(name, title ? { title } : {});
            return;
        }
        case 'tabItem': {
            const label = firstText(closureViews(closureNamed(call, null), env, ctx));
            if (label) view.props.tabLabel = label;
            push(name);
            return;
        }
        case 'badge': {
            const value = arg0 ? display(evalExpr(arg0, env, ctx)) : null;
            if (value) view.props.badgeValue = value;
            push(name);
            return;
        }
        case 'bold':
        case 'italic':
        case 'underline':
        case 'strikethrough': {
            const on = arg0 ? asBool(evalExpr(arg0, env, ctx)) : true;
            if (on !== false) push(name);
            return;
        }
        case 'buttonStyle': {
            const style = memberName(arg0, env, ctx);
            if (view.kind === 'Button' && (style === 'plain' || style === 'borderless')) view.props.style = 'plain';
            push(name);
            return;
        }
        case 'hidden':
            push('opacity', { value: 0 });
            return;
        default:
            push(name);
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parseTreeSitterTree(rootNode: TSNode): TreeSitterParseResult {
    const errors: string[] = [];
    const { structs, globals, mainView } = collectFile(rootNode);
    if (!mainView) {
        return { root: null, errors: ['No struct conforming to View found'] };
    }
    const view: StructInfo = mainView;
    const body = view.viewProps.get('body');
    if (!body) {
        return { root: null, errors: [`"${view.name}" has no "var body: some View"`] };
    }

    const ctx: Context = { structs, globals, depth: 0, inlining: new Set([`struct:${view.name}`]) };
    const env = structEnv(view, null, globals);
    const views = viewsFromStatements(body, env, ctx);

    if (views.length === 0) {
        errors.push(`The body of "${view.name}" produced no visible views`);
        return { root: null, errors };
    }
    const root = views.length === 1 ? views[0] : makeNode('VStack', {}, views);
    return { root, errors };
}
