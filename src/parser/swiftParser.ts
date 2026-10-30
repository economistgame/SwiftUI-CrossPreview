import { ViewNode, Modifier } from './viewTree';
import { parseTreeSitterTree } from './treeSitterParser';

import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TreeSitter: any = require('web-tree-sitter');

// tree-sitter runs as WebAssembly (web-tree-sitter): no native modules, works on
// every OS. It loads asynchronously; until it is ready (or if it fails) the
// regex fallback parser is used.
let parser: any = null;
let initPromise: Promise<boolean> | null = null;

/**
 * Load tree-sitter and the Swift grammar from `wasmDir`
 * (the folder containing tree-sitter.wasm and tree-sitter-swift.wasm).
 * Resolves to true when the tree-sitter parser is ready.
 */
export function initTreeSitter(wasmDir: string): Promise<boolean> {
    if (!initPromise) {
        initPromise = (async () => {
            try {
                await TreeSitter.init({ locateFile: (file: string) => path.join(wasmDir, file) });
                const swift = await TreeSitter.Language.load(path.join(wasmDir, 'tree-sitter-swift.wasm'));
                const p = new TreeSitter();
                p.setLanguage(swift);
                parser = p;
                return true;
            } catch (error) {
                console.warn('tree-sitter (WASM) could not be loaded, using regex fallback parser:', error);
                return false;
            }
        })();
    }
    return initPromise;
}

function getParser(): any {
    return parser;
}

export interface ParseResult {
    root: ViewNode | null;
    errors: string[];
}

/**
 * Parses Swift source code and extracts a ViewNode tree from SwiftUI View structs
 * Returns { root, errors } where root is null if parsing fails
 */
export function parseSwiftToViewTree(source: string): ParseResult {
    const errors: string[] = [];
    
    // Remove single-line comments
    source = removeComments(source);
    
    // Try tree-sitter (WASM) first, when it has finished loading
    const p = getParser();
    let treeSitterResult: ParseResult | null = null;
    if (p) {
        try {
            treeSitterResult = parseTreeSitterTree(p.parse(source).rootNode);
            if (treeSitterResult.root) {
                return treeSitterResult;
            }
        } catch (error) {
            console.warn('Tree-sitter parsing failed, falling back to regex parser:', error);
        }
    }

    // Regex fallback parser
    const regexResult = parseWithRegex(source);
    if (regexResult.root || !treeSitterResult) {
        return regexResult;
    }
    return treeSitterResult;
}

/**
 * Remove single-line // comments from source code
 */
function removeComments(source: string): string {
    // Split by lines, remove // comments, rejoin
    return source.split('\n').map(line => {
        const commentIndex = line.indexOf('//');
        if (commentIndex !== -1) {
            // Check if // is inside a string literal
            const beforeComment = line.substring(0, commentIndex);
            const quoteCount = (beforeComment.match(/"/g) || []).length;
            // Only remove if // is not inside a string (even number of quotes before it)
            if (quoteCount % 2 === 0) {
                return line.substring(0, commentIndex);
            }
        }
        return line;
    }).join('\n');
}

/**
 * Control-flow support for the regex parser.
 *
 * A static preview cannot evaluate runtime conditions, so view-builder
 * control flow is resolved to a representative branch:
 *   - `switch x { case ...: A  case ...: B }`  -> A (first case)
 *   - `if c { A } else if d { B } else { C }`  -> A (first branch)
 * Branches with several views are wrapped in a VStack. Works recursively
 * and ignores keywords inside string literals.
 */

/** Index just past the brace that closes the one at `openIndex` (string-aware). */
function matchBrace(content: string, openIndex: number): number {
    let depth = 0;
    let inString = false;
    for (let i = openIndex; i < content.length; i++) {
        const ch = content[i];
        if (inString) {
            if (ch === '\\') { i++; continue; }
            if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return i + 1;
        }
    }
    return content.length;
}

/** First `{` at index >= from that is outside strings and parentheses. */
function findBlockOpen(content: string, from: number): number {
    let parens = 0;
    let inString = false;
    for (let i = from; i < content.length; i++) {
        const ch = content[i];
        if (inString) {
            if (ch === '\\') { i++; continue; }
            if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '(' || ch === '[') parens++;
        else if (ch === ')' || ch === ']') parens--;
        else if (ch === '{' && parens <= 0) return i;
    }
    return -1;
}

/** Find the next `switch` / `if` keyword outside strings, at a word boundary. */
function findControlKeyword(content: string, from: number): { index: number; keyword: 'switch' | 'if' } | null {
    let inString = false;
    for (let i = from; i < content.length; i++) {
        const ch = content[i];
        if (inString) {
            if (ch === '\\') { i++; continue; }
            if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (i > 0 && /[\w.$]/.test(content[i - 1])) continue;
        for (const keyword of ['switch', 'if'] as const) {
            if (content.startsWith(keyword, i) && /\s/.test(content[i + keyword.length] || '')) {
                return { index: i, keyword };
            }
        }
    }
    return null;
}

/** Number of top-level statements (views) in a block: a new one starts on each
 *  depth-0 line that does not begin with `.` (modifier) or `}`. */
function countTopLevelViews(content: string): number {
    let count = 0;
    let depth = 0;
    let inString = false;
    let lineStart = true;
    for (let i = 0; i < content.length; i++) {
        const ch = content[i];
        if (inString) {
            if (ch === '\\') { i++; continue; }
            if (ch === '"') inString = false;
            continue;
        }
        if (ch === '\n') { lineStart = true; continue; }
        if (/\s/.test(ch)) continue;
        if (lineStart && depth === 0 && ch !== '.' && ch !== '}' && ch !== ')') count++;
        lineStart = false;
        if (ch === '"') inString = true;
        else if (ch === '{' || ch === '(' || ch === '[') depth++;
        else if (ch === '}' || ch === ')' || ch === ']') depth--;
    }
    return count;
}

/** Wrap a branch in a VStack when it contains more than one view. */
function wrapBranch(branch: string): string {
    const trimmed = resolveControlFlow(branch).trim();
    if (!trimmed) return '';
    return countTopLevelViews(trimmed) <= 1 ? trimmed : `VStack {\n${trimmed}\n}`;
}

/** Initial values of properties declared in the file (name -> literal), used to pick branches. */
let knownInitialValues: Record<string, string> = {};

function collectInitialValues(source: string): Record<string, string> {
    const values: Record<string, string> = {};
    const re = /\b(?:var|let)\s+(\w+)\s*(?::\s*[^=\n{]+?)?\s*=\s*([^\n;]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
        if (!(m[1] in values)) values[m[1]] = m[2].trim();
    }
    return values;
}

/** Enum member name of a value such as `.on`, `Estado.on` or `.on(3)`. */
function enumMember(value: string): string | null {
    const m = value.trim().match(/^(?:[A-Z]\w*)?\.(\w+)/);
    return m ? m[1] : null;
}

/** Initial value for a switch/if subject like `estado`, `self.estado` or `radio.estado`. */
function lookupSubject(subject: string): string | null {
    const m = subject.trim().match(/(\w+)\s*$/);
    if (!m) return null;
    return knownInitialValues[m[1]] ?? null;
}

/** Split a switch block into its `case`/`default` clauses. */
function switchCases(inner: string): Array<{ label: string; body: string; isDefault: boolean }> {
    // Locate top-level `case`/`default` labels (depth 0, outside strings)
    const labels: number[] = [];
    let depth = 0;
    let inString = false;
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (inString) {
            if (ch === '\\') { i++; continue; }
            if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{' || ch === '(' || ch === '[') depth++;
        else if (ch === '}' || ch === ')' || ch === ']') depth--;
        else if (depth === 0 && (i === 0 || !/[\w.$]/.test(inner[i - 1])) &&
                 (/^case\s/.test(inner.substring(i, i + 5)) || /^default\s*:/.test(inner.substring(i, i + 12)))) {
            labels.push(i);
        }
    }

    const cases: Array<{ label: string; body: string; isDefault: boolean }> = [];
    labels.forEach((start, idx) => {
        // The label ends at the first top-level ':' after it
        let colon = -1;
        let d = 0;
        for (let i = start; i < inner.length; i++) {
            const ch = inner[i];
            if (ch === '(' || ch === '[') d++;
            else if (ch === ')' || ch === ']') d--;
            else if (ch === ':' && d === 0) { colon = i; break; }
        }
        if (colon === -1) return;
        const end = idx + 1 < labels.length ? labels[idx + 1] : inner.length;
        const isDefault = inner.startsWith('default', start);
        cases.push({
            label: inner.substring(isDefault ? start + 7 : start + 4, colon).trim(),
            body: inner.substring(colon + 1, end),
            isDefault,
        });
    });
    return cases;
}

/** Pick the case matching the subject's initial value, else default, else the first case. */
function chooseSwitchCase(subject: string, inner: string): string {
    const cases = switchCases(inner);
    if (cases.length === 0) return '';
    const value = lookupSubject(subject);
    if (value !== null) {
        const member = enumMember(value);
        for (const c of cases) {
            if (c.isDefault) continue;
            const patterns = c.label.split(',').map(p => p.trim());
            const hit = patterns.some(p => {
                if (member) return enumMember(p.replace(/^let\s+|^var\s+/, '')) === member;
                return p === value;
            });
            if (hit) return c.body;
        }
        const def = cases.find(c => c.isDefault);
        if (def) return def.body;
    }
    return cases[0].body;
}

/** Evaluate a simple condition (`flag`, `!flag`, `a.flag`) from known Bool initial values. */
function evaluateCondition(condition: string): boolean | null {
    const m = condition.trim().match(/^(!?)\s*([\w.]+)$/);
    if (!m) return null;
    const value = lookupSubject(m[2]);
    if (value !== 'true' && value !== 'false') return null;
    return (value === 'true') !== (m[1] === '!');
}

function resolveControlFlow(content: string): string {
    let result = '';
    let pos = 0;

    while (pos < content.length) {
        const found = findControlKeyword(content, pos);
        if (!found) break;

        const condStart = found.index + found.keyword.length;
        const open = findBlockOpen(content, condStart);
        if (open === -1) break;
        let close = matchBrace(content, open);
        const condition = content.substring(condStart, open);
        const inner = content.substring(open + 1, close - 1);

        let replacement: string;
        if (found.keyword === 'switch') {
            replacement = wrapBranch(chooseSwitchCase(condition, inner));
        } else {
            // Collect the if / else-if / else branches
            const branches: Array<{ condition: string | null; body: string }> = [{ condition, body: inner }];
            while (true) {
                const elseMatch = content.substring(close).match(/^\s*else\b(\s*if\b)?/);
                if (!elseMatch) break;
                const afterElse = close + elseMatch[0].length;
                const elseOpen = findBlockOpen(content, afterElse);
                if (elseOpen === -1) break;
                const elseClose = matchBrace(content, elseOpen);
                branches.push({
                    condition: elseMatch[1] ? content.substring(afterElse, elseOpen) : null,
                    body: content.substring(elseOpen + 1, elseClose - 1),
                });
                close = elseClose;
            }

            // Take the first branch whose condition is known to be true; when a
            // condition cannot be evaluated, show that branch.
            let chosen: string | null = null;
            for (const b of branches) {
                const v = b.condition === null ? true : evaluateCondition(b.condition);
                if (v === false) continue;
                chosen = b.body;
                break;
            }
            replacement = chosen === null ? '' : wrapBranch(chosen);
        }

        result += content.substring(pos, found.index) + replacement;
        pos = close;
    }

    return result + content.substring(pos);
}

function parseWithRegex(source: string): ParseResult {
    const errors: string[] = [];
    
    try {
        // Find body property content - handle nested braces
        const bodyStart = source.indexOf('var body');
        if (bodyStart === -1) {
            errors.push('Could not find "var body" property');
            return { root: null, errors };
        }
        
        // Find the opening brace after "some View"
        const viewIndex = source.indexOf('some View', bodyStart);
        const openBraceIndex = source.indexOf('{', viewIndex);
        
        if (openBraceIndex === -1) {
            errors.push('Could not find opening brace for body');
            return { root: null, errors };
        }
        
        // Find matching closing brace
        let braceCount = 1;
        let closeBraceIndex = openBraceIndex + 1;
        
        while (braceCount > 0 && closeBraceIndex < source.length) {
            if (source[closeBraceIndex] === '{') braceCount++;
            if (source[closeBraceIndex] === '}') braceCount--;
            closeBraceIndex++;
        }
        
        // Resolve switch / if-else so the regex parser only sees views
        knownInitialValues = collectInitialValues(source);
        const bodyContent = resolveControlFlow(
            source.substring(openBraceIndex + 1, closeBraceIndex - 1)
        ).trim();

        // Parse the main view (VStack, HStack, etc.)
        const root = parseRegexView(bodyContent);
        
        if (!root) {
            errors.push('Could not parse body content. Supported views: VStack, HStack, ZStack, List, Form, ScrollView, NavigationView, NavigationStack, TabView, Text, Button, Toggle, etc.');
            return { root: null, errors };
        }
        
        return { root, errors };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push(`Parser exception (regex fallback): ${errorMsg}`);
        return { root: null, errors };
    }
}

function parseRegexView(content: string): ViewNode | null {
    content = content.trim();
    
    // Match NavigationView/NavigationStack with their content
    const navMatch = content.match(/^(NavigationView|NavigationStack)\s*\{/);
    if (navMatch) {
        const kind = navMatch[1] as "NavigationView" | "NavigationStack";
        return parseRegexContainer(content, kind);
    }
    
    // Match TabView with their content
    const tabViewMatch = content.match(/^TabView\s*\{/);
    if (tabViewMatch) {
        return parseRegexContainer(content, 'TabView');
    }
    
    // Match NavigationLink
    const navLinkMatch = content.match(/^NavigationLink\("([^"]+)"\)/);
    if (navLinkMatch) {
        return {
            kind: 'NavigationLink',
            props: { label: navLinkMatch[1], destination: '' },
            modifiers: [],
            children: []
        };
    }
    
    // Match AsyncImage
    const asyncImageMatch = content.match(/^AsyncImage\(url:\s*URL\(string:\s*"([^"]+)"\)\)/);
    if (asyncImageMatch) {
        return {
            kind: 'AsyncImage',
            props: { url: asyncImageMatch[1] },
            modifiers: [],
            children: []
        };
    }
    
    // Match TextEditor
    const textEditorMatch = content.match(/^TextEditor\(/);
    if (textEditorMatch) {
        return {
            kind: 'TextEditor',
            props: { text: 'Enter text...' },
            modifiers: [],
            children: []
        };
    }
    
    // Match DisclosureGroup
    const disclosureMatch = content.match(/^DisclosureGroup\("([^"]+)"\)/);
    if (disclosureMatch) {
        return parseRegexContainer(content, 'DisclosureGroup');
    }
    
    // Match List/Form/ScrollView with optional parameters and their content
    const containerMatch = content.match(/^(List|Form|ScrollView)(\s*\([^)]*\))?\s*\{/);
    if (containerMatch) {
        const kind = containerMatch[1] as "List" | "Form" | "ScrollView";
        return parseRegexContainer(content, kind);
    }
    
    // Match VStack/HStack/ZStack with optional parameters and their content
    const stackMatch = content.match(/^(VStack|HStack|ZStack)(\s*\([^)]*\))?\s*\{/);
    if (stackMatch) {
        const kind = stackMatch[1] as "VStack" | "HStack" | "ZStack";
        return parseRegexContainer(content, kind);
    }
    
    // Match ForEach patterns
    const forEachMatch = content.match(/^ForEach\s*\(/);
    if (forEachMatch) {
        return parseRegexForEach(content);
    }
    
    // Match Button
    const buttonMatch = content.match(/^Button\("([^"]+)"\)/);
    if (buttonMatch) {
        return {
            kind: 'Button',
            props: { action: 'action' },
            modifiers: [],
            children: [{
                kind: 'Text',
                props: { text: buttonMatch[1] },
                modifiers: [],
                children: []
            }]
        };
    }
    
    // Match Button with closure label
    const buttonClosureMatch = content.match(/^Button\s*\{/);
    if (buttonClosureMatch) {
        return parseRegexContainer(content, 'Button');
    }
    
    // Match Toggle
    const toggleMatch = content.match(/^Toggle\("([^"]+)"/);
    if (toggleMatch) {
        return {
            kind: 'Toggle',
            props: { label: toggleMatch[1], isOn: true },
            modifiers: [],
            children: []
        };
    }
    
    // Match TextField
    const textFieldMatch = content.match(/^TextField\("([^"]+)"/);
    if (textFieldMatch) {
        return {
            kind: 'TextField',
            props: { placeholder: textFieldMatch[1], text: '' },
            modifiers: [],
            children: []
        };
    }
    
    // Match SecureField
    const secureFieldMatch = content.match(/^SecureField\("([^"]+)"/);
    if (secureFieldMatch) {
        return {
            kind: 'SecureField',
            props: { placeholder: secureFieldMatch[1], text: '' },
            modifiers: [],
            children: []
        };
    }
    
    // Match shapes
    if (content.startsWith('Rectangle()')) {
        return { kind: 'Rectangle', props: {}, modifiers: [], children: [] };
    }
    if (content.startsWith('Circle()')) {
        return { kind: 'Circle', props: {}, modifiers: [], children: [] };
    }
    const roundedRectMatch = content.match(/^RoundedRectangle\(cornerRadius:\s*(\d+)\)/);
    if (roundedRectMatch) {
        return {
            kind: 'RoundedRectangle',
            props: { cornerRadius: parseInt(roundedRectMatch[1]) },
            modifiers: [],
            children: []
        };
    }
    if (content.startsWith('Capsule()')) {
        return { kind: 'Capsule', props: {}, modifiers: [], children: [] };
    }
    if (content.startsWith('Ellipse()')) {
        return { kind: 'Ellipse', props: {}, modifiers: [], children: [] };
    }
    
    // Match Divider
    if (content.startsWith('Divider()')) {
        return { kind: 'Divider', props: {}, modifiers: [], children: [] };
    }
    
    // Match Label
    const labelMatch = content.match(/^Label\("([^"]+)",\s*systemImage:\s*"([^"]+)"\)/);
    if (labelMatch) {
        return {
            kind: 'Label',
            props: { title: labelMatch[1], systemImage: labelMatch[2] },
            modifiers: [],
            children: []
        };
    }
    
    // Match Slider
    if (content.startsWith('Slider(')) {
        const sliderMatch = content.match(/^Slider\([^)]*\)/);
        if (sliderMatch) {
            // Extract value and range: Slider(value: 7, in: 0...10)
            const valueMatch = sliderMatch[0].match(/value:\s*([\d.]+)/);
            const rangeMatch = sliderMatch[0].match(/in:\s*([\d.]+)\.{2,3}([\d.]+)/);
            
            const value = valueMatch ? parseFloat(valueMatch[1]) : 0.5;
            const min = rangeMatch ? parseFloat(rangeMatch[1]) : 0;
            const max = rangeMatch ? parseFloat(rangeMatch[2]) : 1;
            
            return { kind: 'Slider', props: { value, range: [min, max] }, modifiers: [], children: [] };
        }
        return { kind: 'Slider', props: { value: 0.5, range: [0, 1] }, modifiers: [], children: [] };
    }
    
    // Match Stepper
    const stepperMatch = content.match(/^Stepper\("([^"]+)"/);
    if (stepperMatch) {
        return { kind: 'Stepper', props: { label: stepperMatch[1], value: 0 }, modifiers: [], children: [] };
    }
    
    // Match DatePicker
    const datePickerMatch = content.match(/^DatePicker\("([^"]+)"/);
    if (datePickerMatch) {
        return { kind: 'DatePicker', props: { label: datePickerMatch[1] }, modifiers: [], children: [] };
    }
    
    // Match ColorPicker
    const colorPickerMatch = content.match(/^ColorPicker\("([^"]+)"/);
    if (colorPickerMatch) {
        return { kind: 'ColorPicker', props: { label: colorPickerMatch[1] }, modifiers: [], children: [] };
    }
    
    // Match ProgressView
    if (content.startsWith('ProgressView()')) {
        return { kind: 'ProgressView', props: { value: null }, modifiers: [], children: [] };
    }
    
    // Match Link
    const linkMatch = content.match(/^Link\("([^"]+)"/);
    if (linkMatch) {
        return { kind: 'Link', props: { title: linkMatch[1], destination: '#' }, modifiers: [], children: [] };
    }
    
    // Match LazyVStack/LazyHStack/Grid/Group
    const lazyStackMatch = content.match(/^(LazyVStack|LazyHStack|Grid|Group)\s*\{/);
    if (lazyStackMatch) {
        const kind = lazyStackMatch[1] as "LazyVStack" | "LazyHStack" | "Grid" | "Group";
        return parseRegexContainer(content, kind);
    }
    
    // Match simple Text
    const textMatch = content.match(/^Text\("([^"]+)"\)/);
    if (textMatch) {
        return {
            kind: 'Text',
            props: { text: textMatch[1] },
            modifiers: [],
            children: []
        };
    }
    
    // Fallback: Handle custom views (like HomeDashboardView(), SettingsFormView(), etc.)
    const customViewMatch = content.match(/^([A-Z][a-zA-Z0-9]*View)\s*\(/);
    if (customViewMatch) {
        return {
            kind: 'Group',
            props: { customView: customViewMatch[1] },
            modifiers: [],
            children: [{
                kind: 'Text',
                props: { text: `<${customViewMatch[1]}>` },
                modifiers: [],
                children: []
            }]
        };
    }
    
    return null;
}

/**
 * Parse container views (VStack, HStack, ZStack, List, Form, ScrollView, NavigationView, TabView, etc.) with regex
 */
function parseRegexContainer(content: string, kind: "VStack" | "HStack" | "ZStack" | "List" | "Form" | "ScrollView" | "LazyVStack" | "LazyHStack" | "LazyVGrid" | "LazyHGrid" | "Grid" | "Group" | "GeometryReader" | "NavigationView" | "NavigationStack" | "TabView" | "DisclosureGroup" | "Button"): ViewNode {
    const stackProps: Record<string, any> = {};
    
    // Try to parse stack parameters (alignment, spacing) if applicable
    const stackParamsMatch = content.match(/^(VStack|HStack|ZStack)\s*\(([^)]*)\)/);
    if (stackParamsMatch) {
        const params = stackParamsMatch[2];
        const alignmentMatch = params.match(/alignment:\s*\.(\w+)/);
        const spacingMatch = params.match(/spacing:\s*([\d.]+)/);
        if (alignmentMatch) stackProps.alignment = alignmentMatch[1];
        if (spacingMatch) stackProps.spacing = parseFloat(spacingMatch[1]);
    }
    
    // Find the opening brace
    const openBraceIndex = content.indexOf('{');
    if (openBraceIndex === -1) {
        return { kind, props: stackProps, modifiers: [], children: [] };
    }
    
    // Find matching closing brace
    let braceCount = 1;
    let i = openBraceIndex + 1;
    
    while (braceCount > 0 && i < content.length) {
        if (content[i] === '{') braceCount++;
        if (content[i] === '}') braceCount--;
        i++;
    }
    
    const innerContent = content.substring(openBraceIndex + 1, i - 1).trim();
    const children: ViewNode[] = [];
    
    // Parse child views (Text, ForEach, Section, etc.)
    let pos = 0;
    while (pos < innerContent.length) {
        // Skip leading whitespace so offsets computed on `remaining` match `pos`
        while (pos < innerContent.length && /\s/.test(innerContent[pos])) pos++;
        const remaining = innerContent.substring(pos).trim();
        if (!remaining) break;
        
        // Try nested containers (VStack, HStack, ZStack) first
        const nestedStackMatch = remaining.match(/^(VStack|HStack|ZStack)(\s*\([^)]*\))?\s*\{/);
        if (nestedStackMatch) {
            const nestedKind = nestedStackMatch[1] as "VStack" | "HStack" | "ZStack";
            const nestedNode = parseRegexContainer(remaining, nestedKind);
            if (nestedNode) {
                children.push(nestedNode);
                const closureEnd = findClosureEnd(remaining);
                pos += innerContent.substring(pos).indexOf(remaining[0]) + skipModifiers(remaining, closureEnd);
                continue;
            }
        }
        
        // Try ForEach
        if (remaining.startsWith('ForEach')) {
            const forEachNode = parseRegexForEach(remaining);
            if (forEachNode) {
                children.push(forEachNode);
                // Find end of ForEach block
                const closureEnd = findClosureEnd(remaining);
                pos += remaining.length - remaining.substring(closureEnd).length;
                continue;
            }
        }
        
        // Try Text
        const textMatch = remaining.match(/^Text\("([^"]+)"\)/);
        if (textMatch) {
            const text = textMatch[1];
            let currentPos = textMatch[0].length;
            const modifiers: Modifier[] = [];
            
            while (currentPos < remaining.length) {
                // Handle whitespace properly
                const afterView = remaining.substring(currentPos);
                const trimmed = afterView.trimStart();
                const whitespaceLen = afterView.length - trimmed.length;
                currentPos += whitespaceLen;
                
                // Check if next non-whitespace is a dot (modifier)
                if (!trimmed.startsWith('.')) {
                    break;
                }
                
                // Parse modifier - handle both .modifier() and .modifier(args)
                const modMatch = trimmed.match(/^\.(\w+)(\(([^)]*)\))?/);
                if (modMatch) {
                    const modName = modMatch[1];
                    const modArgs = modMatch[3] || '';
                    
                    // Parse modifier arguments
                    const args: Record<string, any> = {};
                    
                    if (modName === 'padding') {
                        if (modArgs) {
                            const num = parseFloat(modArgs);
                            if (!isNaN(num)) args.all = num;
                        } else {
                            args.all = 16; // default padding
                        }
                    } else if (modName === 'font') {
                        const fontMatch = modArgs.match(/\.(\w+)/);
                        if (fontMatch) args.style = fontMatch[1];
                    } else if (modName === 'foregroundColor') {
                        const colorMatch = modArgs.match(/\.(\w+)/);
                        if (colorMatch) args.color = colorMatch[1];
                    } else if (modName === 'foregroundStyle') {
                        const colorMatch = modArgs.match(/\.(\w+)/);
                        if (colorMatch) args.color = colorMatch[1];
                    } else if (modName === 'background') {
                        // Check for material or color
                        const materialMatch = modArgs.match(/\.(ultraThin|thin|regular|thick|ultraThick)Material/);
                        const colorMatch = modArgs.match(/\.(\w+)/);
                        if (materialMatch) {
                            args.material = materialMatch[1];
                        } else if (colorMatch) {
                            args.color = colorMatch[1];
                        }
                    } else if (modName === 'cornerRadius') {
                        const num = parseFloat(modArgs);
                        if (!isNaN(num)) args.radius = num;
                    } else if (modName === 'shadow') {
                        const radiusMatch = modArgs.match(/radius:\s*([\d.]+)/);
                        if (radiusMatch) {
                            args.radius = parseFloat(radiusMatch[1]);
                        } else {
                            args.radius = 8; // default
                        }
                    } else if (modName === 'opacity') {
                        const num = parseFloat(modArgs);
                        if (!isNaN(num)) args.value = num;
                    } else if (modName === 'blur') {
                        const radiusMatch = modArgs.match(/radius:\s*([\d.]+)/);
                        if (radiusMatch) {
                            args.radius = parseFloat(radiusMatch[1]);
                        }
                    } else if (modName === 'multilineTextAlignment') {
                        const alignMatch = modArgs.match(/\.(\w+)/);
                        if (alignMatch) args.alignment = alignMatch[1];
                    } else if (modName === 'lineLimit') {
                        const num = parseInt(modArgs);
                        if (!isNaN(num)) args.lines = num;
                    } else if (modName === 'frame') {
                        const widthMatch = modArgs.match(/width:\s*(\d+)/);
                        const heightMatch = modArgs.match(/height:\s*(\d+)/);
                        const maxWidthMatch = modArgs.match(/maxWidth:\s*\.infinity/);
                        if (widthMatch) args.width = parseInt(widthMatch[1]);
                        if (heightMatch) args.height = parseInt(heightMatch[1]);
                        if (maxWidthMatch) args.maxWidth = 'infinity';
                    } else if (modName === 'onTapGesture') {
                        args.hasGesture = true;
                    } else if (modName === 'onLongPressGesture') {
                        args.hasLongPress = true;
                    } else if (modName === 'disabled') {
                        const boolMatch = modArgs.match(/(true|false)/);
                        args.isDisabled = boolMatch ? boolMatch[1] === 'true' : true;
                    } else if (modName === 'bold') {
                        args.isBold = true;
                    } else if (modName === 'animation') {
                        args.hasAnimation = true;
                        // Try to extract animation type
                        const typeMatch = modArgs.match(/\.(easeInOut|easeIn|easeOut|linear|spring)/);
                        if (typeMatch) args.animationType = typeMatch[1];
                    } else if (modName === 'rotationEffect') {
                        args.hasAnimation = true;
                        // Handle .degrees(value) or .degrees(condition ? value1 : value2)
                        const degreeMatch = modArgs.match(/\.degrees\(([^)]+)\)/);
                        if (degreeMatch) {
                            const degreeExpr = degreeMatch[1];
                            // Check for ternary - take the larger absolute value
                            const ternaryMatch = degreeExpr.match(/\?.*?([-\d.]+)\s*:\s*([-\d.]+)/);
                            if (ternaryMatch) {
                                const val1 = Math.abs(parseFloat(ternaryMatch[1]));
                                const val2 = Math.abs(parseFloat(ternaryMatch[2]));
                                args.degrees = Math.max(val1, val2);
                            } else {
                                const simpleMatch = degreeExpr.match(/([-\d.]+)/);
                                if (simpleMatch) args.degrees = parseFloat(simpleMatch[1]);
                            }
                        }
                    } else if (modName === 'scaleEffect') {
                        args.hasAnimation = true;
                        // Handle simple value or ternary
                        const ternaryMatch = modArgs.match(/\?.*?([\d.]+)\s*:\s*([\d.]+)/);
                        if (ternaryMatch) {
                            const val1 = parseFloat(ternaryMatch[1]);
                            const val2 = parseFloat(ternaryMatch[2]);
                            // Use the value furthest from 1
                            args.scale = Math.abs(val1 - 1) > Math.abs(val2 - 1) ? val1 : val2;
                        } else {
                            const scaleMatch = modArgs.match(/([\d.]+)/);
                            if (scaleMatch) args.scale = parseFloat(scaleMatch[1]);
                        }
                    }
                    
                    modifiers.push({ name: modName, args });
                    currentPos += modMatch[0].length;
                } else {
                    break;
                }
            }
            
            children.push({
                kind: 'Text',
                props: { text },
                modifiers,
                children: []
            });
            
            pos += currentPos;
        } else if (remaining.startsWith('Button')) {
            // Parse Button with modifiers
            const buttonMatch = remaining.match(/^Button\("([^"]+)"\)\s*\{/);
            if (buttonMatch) {
                const buttonText = buttonMatch[1];
                let currentPos = buttonMatch[0].length;
                
                // Find end of closure
                let braceCount = 1;
                while (braceCount > 0 && currentPos < remaining.length) {
                    if (remaining[currentPos] === '{') braceCount++;
                    if (remaining[currentPos] === '}') braceCount--;
                    currentPos++;
                }
                
                // Parse modifiers after the button
                const modifiers: Modifier[] = [];
                while (currentPos < remaining.length) {
                    const modRemaining = remaining.substring(currentPos).trim();
                    if (!modRemaining.startsWith('.')) break;
                    
                    const modMatch = modRemaining.match(/^\.(\w+)\(([^)]*)\)/);
                    if (modMatch) {
                        const modName = modMatch[1];
                        const modArgs = modMatch[2];
                        const args: Record<string, any> = {};
                        
                        if (modName === 'padding' && modArgs) {
                            const num = parseFloat(modArgs);
                            if (!isNaN(num)) args.all = num;
                        } else if (modName === 'font' && modArgs) {
                            const fontMatch = modArgs.match(/\.(\w+)/);
                            if (fontMatch) args.style = fontMatch[1];
                        } else if (modName === 'foregroundColor' && modArgs) {
                            const colorMatch = modArgs.match(/\.(\w+)/);
                            if (colorMatch) args.color = colorMatch[1];
                        } else if (modName === 'background' && modArgs) {
                            const colorMatch = modArgs.match(/\.(\w+)/);
                            if (colorMatch) args.color = colorMatch[1];
                        } else if (modName === 'cornerRadius' && modArgs) {
                            const num = parseFloat(modArgs);
                            if (!isNaN(num)) args.radius = num;
                        } else if (modName === 'frame' && modArgs) {
                            const widthMatch = modArgs.match(/width:\s*(\d+)/);
                            const heightMatch = modArgs.match(/height:\s*(\d+)/);
                            if (widthMatch) args.width = parseInt(widthMatch[1]);
                            if (heightMatch) args.height = parseInt(heightMatch[1]);
                        }
                        
                        modifiers.push({ name: modName, args });
                        currentPos += remaining.substring(currentPos).indexOf(modMatch[0]) + modMatch[0].length;
                    } else {
                        break;
                    }
                }
                
                children.push({
                    kind: 'Button',
                    props: { action: 'action' },
                    modifiers,
                    children: [{
                        kind: 'Text',
                        props: { text: buttonText },
                        modifiers: [],
                        children: []
                    }]
                });
                
                pos += currentPos;
            } else {
                // Not a valid button, skip ahead
                pos += 6; // length of "Button"
            }
        } else if (remaining.startsWith('Divider()')) {
            children.push({ kind: 'Divider', props: {}, modifiers: [], children: [] });
            pos += skipModifiers(remaining, 9);
        } else if (remaining.startsWith('Spacer()')) {
            children.push({ kind: 'Spacer', props: {}, modifiers: [], children: [] });
            pos += skipModifiers(remaining, 8);
        } else if (remaining.startsWith('Rectangle()')) {
            let currentPos = 11; // length of "Rectangle()"
            const modifiers: Modifier[] = [];
            
            // Parse modifiers
            while (currentPos < remaining.length) {
                const afterView = remaining.substring(currentPos);
                const trimmed = afterView.trimStart();
                const whitespaceLen = afterView.length - trimmed.length;
                currentPos += whitespaceLen;
                
                if (!trimmed.startsWith('.')) break;
                
                const modMatch = trimmed.match(/^\.(\w+)(\(([^)]*)\))?/);
                if (modMatch) {
                    const modName = modMatch[1];
                    const modArgs = modMatch[3] || '';
                    const args: Record<string, any> = {};
                    
                    if (modName === 'fill') {
                        // Check for material first
                        const materialMatch = modArgs.match(/\.(ultraThinMaterial|thinMaterial|regularMaterial|thickMaterial|ultraThickMaterial)/);
                        if (materialMatch) {
                            args.material = materialMatch[1].replace('Material', '');
                        } else {
                            const colorMatch = modArgs.match(/\.(\w+)/);
                            if (colorMatch) args.color = colorMatch[1];
                        }
                    } else if (modName === 'frame') {
                        const widthMatch = modArgs.match(/width:\s*(\d+)/);
                        const heightMatch = modArgs.match(/height:\s*(\d+)/);
                        if (widthMatch) args.width = parseInt(widthMatch[1]);
                        if (heightMatch) args.height = parseInt(heightMatch[1]);
                    } else if (modName === 'cornerRadius') {
                        const num = parseFloat(modArgs);
                        if (!isNaN(num)) args.radius = num;
                    } else if (modName === 'position') {
                        const xMatch = modArgs.match(/x:\s*(\d+)/);
                        const yMatch = modArgs.match(/y:\s*(\d+)/);
                        if (xMatch) args.x = parseInt(xMatch[1]);
                        if (yMatch) args.y = parseInt(yMatch[1]);
                    } else if (modName === 'clipShape') {
                        if (modArgs.includes('Circle')) args.shape = 'circle';
                        else if (modArgs.includes('Capsule')) args.shape = 'capsule';
                        else if (modArgs.includes('RoundedRectangle')) {
                            args.shape = 'roundedRectangle';
                            const radiusMatch = modArgs.match(/cornerRadius:\s*(\d+)/);
                            if (radiusMatch) args.cornerRadius = parseInt(radiusMatch[1]);
                        }
                        else args.shape = 'rectangle';
                    }
                    
                    modifiers.push({ name: modName, args });
                    currentPos += modMatch[0].length;
                } else {
                    break;
                }
            }
            
            children.push({ kind: 'Rectangle', props: {}, modifiers, children: [] });
            pos += currentPos;
        } else if (remaining.startsWith('Circle()')) {
            let currentPos = 8; // length of "Circle()"
            const modifiers: Modifier[] = [];
            
            // Parse modifiers
            while (currentPos < remaining.length) {
                const afterView = remaining.substring(currentPos);
                const trimmed = afterView.trimStart();
                const whitespaceLen = afterView.length - trimmed.length;
                currentPos += whitespaceLen;
                
                if (!trimmed.startsWith('.')) break;
                
                const modMatch = trimmed.match(/^\.(\w+)(\(([^)]*)\))?/);
                if (modMatch) {
                    const modName = modMatch[1];
                    const modArgs = modMatch[3] || '';
                    const args: Record<string, any> = {};
                    
                    if (modName === 'fill') {
                        // Handle both Color.blue and .blue formats
                        const colorMatch = modArgs.match(/(?:Color\.)?(\w+)/);
                        if (colorMatch) args.color = colorMatch[1];
                    } else if (modName === 'frame') {
                        const widthMatch = modArgs.match(/width:\s*(\d+)/);
                        const heightMatch = modArgs.match(/height:\s*(\d+)/);
                        if (widthMatch) args.width = parseInt(widthMatch[1]);
                        if (heightMatch) args.height = parseInt(heightMatch[1]);
                    } else if (modName === 'position') {
                        const xMatch = modArgs.match(/x:\s*(\d+)/);
                        const yMatch = modArgs.match(/y:\s*(\d+)/);
                        if (xMatch) args.x = parseInt(xMatch[1]);
                        if (yMatch) args.y = parseInt(yMatch[1]);
                    } else if (modName === 'clipShape') {
                        if (modArgs.includes('Circle')) args.shape = 'circle';
                        else if (modArgs.includes('Capsule')) args.shape = 'capsule';
                        else if (modArgs.includes('RoundedRectangle')) {
                            args.shape = 'roundedRectangle';
                            const radiusMatch = modArgs.match(/cornerRadius:\s*(\d+)/);
                            if (radiusMatch) args.cornerRadius = parseInt(radiusMatch[1]);
                        }
                    } else if (modName === 'animation') {
                        args.hasAnimation = true;
                        const typeMatch = modArgs.match(/\.(easeInOut|easeIn|easeOut|linear|spring)/);
                        if (typeMatch) args.animationType = typeMatch[1];
                    } else if (modName === 'scaleEffect') {
                        args.hasAnimation = true;
                        const scaleMatch = modArgs.match(/([\d.]+)/);
                        if (scaleMatch) args.scale = parseFloat(scaleMatch[1]);
                    }
                    
                    modifiers.push({ name: modName, args });
                    currentPos += modMatch[0].length;
                } else {
                    break;
                }
            }
            
            children.push({ kind: 'Circle', props: {}, modifiers, children: [] });
            pos += currentPos;
        } else if (remaining.startsWith('Capsule()')) {
            const capsuleView = parseRegexView(remaining);
            if (capsuleView) children.push(capsuleView);
            pos += skipModifiers(remaining, 9);
        } else if (remaining.startsWith('Ellipse()')) {
            const ellipseView = parseRegexView(remaining);
            if (ellipseView) children.push(ellipseView);
            pos += skipModifiers(remaining, 9);
        } else if (remaining.match(/^RoundedRectangle\(cornerRadius:\s*\d+\)/)) {
            const rrMatch = remaining.match(/^RoundedRectangle\(cornerRadius:\s*(\d+)\)/);
            if (rrMatch) {
                let currentPos = rrMatch[0].length;
                const modifiers: Modifier[] = [];
                const cornerRadius = parseInt(rrMatch[1]);
                
                // Parse modifiers
                while (currentPos < remaining.length) {
                    const afterView = remaining.substring(currentPos);
                    const trimmed = afterView.trimStart();
                    const whitespaceLen = afterView.length - trimmed.length;
                    currentPos += whitespaceLen;
                    
                    if (!trimmed.startsWith('.')) break;
                    
                    // Handle multi-line fill with LinearGradient
                    if (trimmed.startsWith('.fill(')) {
                        // Find matching closing paren - count parens (handles multi-line)
                        let parenCount = 1; // We're inside .fill(
                        let fillEnd = 6; // start after ".fill("
                        while (fillEnd < trimmed.length && parenCount > 0) {
                            if (trimmed[fillEnd] === '(') parenCount++;
                            if (trimmed[fillEnd] === ')') parenCount--;
                            fillEnd++;
                        }
                        const fillContent = trimmed.substring(6, fillEnd - 1);
                        const args: Record<string, any> = {};
                        
                        // Check for LinearGradient
                        if (fillContent.includes('LinearGradient')) {
                            args.gradient = 'linear';
                            // Extract colors - handle [.purple, .pink] format
                            const colorsMatch = fillContent.match(/colors:\s*\[([^\]]+)\]/);
                            if (colorsMatch) {
                                const colorList = colorsMatch[1]
                                    .split(',')
                                    .map(c => c.trim().replace(/^\./, '')); // Remove leading dot
                                args.colors = colorList;
                            }
                        } else {
                            const colorMatch = fillContent.match(/(?:Color\.)?\.?(\w+)/);
                            if (colorMatch) args.color = colorMatch[1];
                        }
                        
                        modifiers.push({ name: 'fill', args });
                        currentPos += fillEnd;
                        continue;
                    }
                    
                    const modMatch = trimmed.match(/^\.(\w+)(\(([^)]*)\))?/);
                    if (modMatch) {
                        const modName = modMatch[1];
                        const modArgs = modMatch[3] || '';
                        const args: Record<string, any> = {};
                        
                        if (modName === 'frame') {
                            const widthMatch = modArgs.match(/width:\s*(\d+)/);
                            const heightMatch = modArgs.match(/height:\s*(\d+)/);
                            if (widthMatch) args.width = parseInt(widthMatch[1]);
                            if (heightMatch) args.height = parseInt(heightMatch[1]);
                        } else if (modName === 'animation') {
                            args.hasAnimation = true;
                            const typeMatch = modArgs.match(/\.(easeInOut|easeIn|easeOut|linear|spring)/);
                            if (typeMatch) args.animationType = typeMatch[1];
                        } else if (modName === 'rotationEffect') {
                            args.hasAnimation = true;
                            // Handle .degrees(value) or .degrees(condition ? value1 : value2)
                            const degreeMatch = modArgs.match(/\.degrees\(([^)]+)\)/);
                            if (degreeMatch) {
                                const degreeExpr = degreeMatch[1];
                                const ternaryMatch = degreeExpr.match(/\?.*?([-\d.]+)\s*:\s*([-\d.]+)/);
                                if (ternaryMatch) {
                                    const val1 = Math.abs(parseFloat(ternaryMatch[1]));
                                    const val2 = Math.abs(parseFloat(ternaryMatch[2]));
                                    args.degrees = Math.max(val1, val2);
                                } else {
                                    const simpleMatch = degreeExpr.match(/([-\d.]+)/);
                                    if (simpleMatch) args.degrees = parseFloat(simpleMatch[1]);
                                }
                            }
                        } else if (modName === 'scaleEffect') {
                            args.hasAnimation = true;
                            const ternaryMatch = modArgs.match(/\?.*?([\d.]+)\s*:\s*([\d.]+)/);
                            if (ternaryMatch) {
                                const val1 = parseFloat(ternaryMatch[1]);
                                const val2 = parseFloat(ternaryMatch[2]);
                                args.scale = Math.abs(val1 - 1) > Math.abs(val2 - 1) ? val1 : val2;
                            } else {
                                const scaleMatch = modArgs.match(/([\d.]+)/);
                                if (scaleMatch) args.scale = parseFloat(scaleMatch[1]);
                            }
                        }
                        
                        modifiers.push({ name: modName, args });
                        currentPos += modMatch[0].length;
                    } else {
                        break;
                    }
                }
                
                children.push({ kind: 'RoundedRectangle', props: { cornerRadius }, modifiers, children: [] });
                pos += currentPos;
            }
        } else if (remaining.match(/^Image\((systemName:\s*)?"/)) {
            const imgMatch = remaining.match(/^Image\((?:systemName:\s*)?"([^"]+)"\)/);
            if (imgMatch) {
                const imgProps: Record<string, any> = { name: imgMatch[1] };
                if (remaining.startsWith('Image(systemName')) imgProps.systemName = true;
                children.push({ kind: 'Image', props: imgProps, modifiers: [], children: [] });
                pos += skipModifiers(remaining, imgMatch[0].length);
            } else {
                pos++;
            }
        } else if (remaining.match(/^Toggle\("/)) {
            const toggleMatch = remaining.match(/^Toggle\("([^"]+)"/);
            if (toggleMatch) {
                children.push({ kind: 'Toggle', props: { label: toggleMatch[1], isOn: true }, modifiers: [], children: [] });
                // Find the closing paren for Toggle
                let toggleEnd = toggleMatch[0].length;
                while (toggleEnd < remaining.length && remaining[toggleEnd] !== ')') {
                    toggleEnd++;
                }
                if (remaining[toggleEnd] === ')') toggleEnd++;
                pos += skipModifiers(remaining, toggleEnd);
            } else {
                pos++;
            }
        } else if (remaining.match(/^TextField\("/)) {
            const tfMatch = remaining.match(/^TextField\("([^"]+)"/);
            if (tfMatch) {
                children.push({ kind: 'TextField', props: { placeholder: tfMatch[1], text: '' }, modifiers: [], children: [] });
                // Find the closing paren
                let tfEnd = tfMatch[0].length;
                while (tfEnd < remaining.length && remaining[tfEnd] !== ')') {
                    tfEnd++;
                }
                if (remaining[tfEnd] === ')') tfEnd++;
                pos += skipModifiers(remaining, tfEnd);
            } else {
                pos++;
            }
        } else if (remaining.match(/^SecureField\("/)) {
            const sfMatch = remaining.match(/^SecureField\("([^"]+)"/);
            if (sfMatch) {
                children.push({ kind: 'SecureField', props: { placeholder: sfMatch[1], text: '' }, modifiers: [], children: [] });
                // Find the closing paren
                let sfEnd = sfMatch[0].length;
                while (sfEnd < remaining.length && remaining[sfEnd] !== ')') {
                    sfEnd++;
                }
                if (remaining[sfEnd] === ')') sfEnd++;
                pos += skipModifiers(remaining, sfEnd);
            } else {
                pos++;
            }
        } else if (remaining.match(/^Label\("/)) {
            const lblMatch = remaining.match(/^Label\("([^"]+)",\s*systemImage:\s*"([^"]+)"\)/);
            if (lblMatch) {
                children.push({ kind: 'Label', props: { title: lblMatch[1], systemImage: lblMatch[2] }, modifiers: [], children: [] });
                pos += skipModifiers(remaining, lblMatch[0].length);
            } else {
                pos++;
            }
        } else if (remaining.startsWith('Slider(')) {
            const sliderMatch = remaining.match(/^Slider\([^)]*\)/);
            if (sliderMatch) {
                // Extract value and range: Slider(value: 7, in: 0...10)
                const valueMatch = sliderMatch[0].match(/value:\s*([\d.]+)/);
                const rangeMatch = sliderMatch[0].match(/in:\s*([\d.]+)\.{2,3}([\d.]+)/);
                
                const value = valueMatch ? parseFloat(valueMatch[1]) : 0.5;
                const min = rangeMatch ? parseFloat(rangeMatch[1]) : 0;
                const max = rangeMatch ? parseFloat(rangeMatch[2]) : 1;
                
                children.push({ kind: 'Slider', props: { value, range: [min, max] }, modifiers: [], children: [] });
                pos += skipModifiers(remaining, sliderMatch[0].length);
            } else {
                pos++;
            }
        } else if (remaining.match(/^Stepper\("/)) {
            const stepMatch = remaining.match(/^Stepper\("([^"]+)"/);
            if (stepMatch) {
                children.push({ kind: 'Stepper', props: { label: stepMatch[1], value: 0 }, modifiers: [], children: [] });
                // Find the closing paren
                let stepEnd = stepMatch[0].length;
                while (stepEnd < remaining.length && remaining[stepEnd] !== ')') {
                    stepEnd++;
                }
                if (remaining[stepEnd] === ')') stepEnd++;
                pos += skipModifiers(remaining, stepEnd);
            } else {
                pos++;
            }
        } else if (remaining.match(/^DatePicker\("/)) {
            const dpMatch = remaining.match(/^DatePicker\("([^"]+)"/);
            if (dpMatch) {
                children.push({ kind: 'DatePicker', props: { label: dpMatch[1] }, modifiers: [], children: [] });
                // Find the closing paren
                let dpEnd = dpMatch[0].length;
                while (dpEnd < remaining.length && remaining[dpEnd] !== ')') {
                    dpEnd++;
                }
                if (remaining[dpEnd] === ')') dpEnd++;
                pos += skipModifiers(remaining, dpEnd);
            } else {
                pos++;
            }
        } else if (remaining.match(/^ColorPicker\("/)) {
            const cpMatch = remaining.match(/^ColorPicker\("([^"]+)"/);
            if (cpMatch) {
                children.push({ kind: 'ColorPicker', props: { label: cpMatch[1] }, modifiers: [], children: [] });
                // Find the closing paren
                let cpEnd = cpMatch[0].length;
                while (cpEnd < remaining.length && remaining[cpEnd] !== ')') {
                    cpEnd++;
                }
                if (remaining[cpEnd] === ')') cpEnd++;
                pos += skipModifiers(remaining, cpEnd);
            } else {
                pos++;
            }
        } else if (remaining.startsWith('ProgressView()')) {
            children.push({ kind: 'ProgressView', props: {}, modifiers: [], children: [] });
            pos += skipModifiers(remaining, 14);
        } else if (remaining.match(/^Link\("/)) {
            const linkMatch = remaining.match(/^Link\("([^"]+)",\s*destination:\s*URL\(string:\s*"([^"]+)"\)/);
            if (linkMatch) {
                children.push({ kind: 'Link', props: { title: linkMatch[1], destination: linkMatch[2] }, modifiers: [], children: [] });
                pos += skipModifiers(remaining, linkMatch[0].length);
            } else {
                pos++;
            }
        } else if (remaining.match(/^Picker\("/)) {
            const pickerMatch = remaining.match(/^Picker\("([^"]+)"/);
            if (pickerMatch) {
                children.push({ kind: 'Picker', props: { label: pickerMatch[1] }, modifiers: [], children: [] });
                // Find the closing paren
                let pickEnd = pickerMatch[0].length;
                while (pickEnd < remaining.length && remaining[pickEnd] !== ')') {
                    pickEnd++;
                }
                if (remaining[pickEnd] === ')') pickEnd++;
                pos += skipModifiers(remaining, pickEnd);
            } else {
                pos++;
            }
        } else if (remaining.match(/^LinearGradient\(/)) {
            const lgMatch = remaining.match(/^LinearGradient\([^)]*\)/);
            if (lgMatch) {
                children.push({ kind: 'LinearGradient', props: { colors: ['blue', 'purple'] }, modifiers: [], children: [] });
                pos += skipModifiers(remaining, lgMatch[0].length);
            } else {
                pos++;
            }
        } else if (remaining.match(/^RadialGradient\(/)) {
            const rgMatch = remaining.match(/^RadialGradient\([^)]*\)/);
            if (rgMatch) {
                children.push({ kind: 'RadialGradient', props: { colors: ['blue', 'purple'] }, modifiers: [], children: [] });
                pos += skipModifiers(remaining, rgMatch[0].length);
            } else {
                pos++;
            }
        } else if (remaining.match(/^AsyncImage\(/)) {
            const aiMatch = remaining.match(/^AsyncImage\(url:\s*URL\(string:\s*"([^"]+)"\)/);
            if (aiMatch) {
                children.push({ kind: 'AsyncImage', props: { url: aiMatch[1] }, modifiers: [], children: [] });
                pos += skipModifiers(remaining, aiMatch[0].length);
            } else {
                pos++;
            }
        } else if (remaining.startsWith('TextEditor(')) {
            const teMatch = remaining.match(/^TextEditor\([^)]*\)/);
            if (teMatch) {
                children.push({ kind: 'TextEditor', props: { text: 'Enter text...' }, modifiers: [], children: [] });
                pos += skipModifiers(remaining, teMatch[0].length);
            } else {
                pos++;
            }
        } else if (remaining.match(/^NavigationLink\("/)) {
            const nlMatch = remaining.match(/^NavigationLink\("([^"]+)"\)/);
            if (nlMatch) {
                children.push({ kind: 'NavigationLink', props: { label: nlMatch[1], destination: '' }, modifiers: [], children: [] });
                pos += skipModifiers(remaining, nlMatch[0].length);
            } else {
                pos++;
            }
        } else {
            pos++;
        }
    }
        
    // Parse modifiers on the container itself
    const stackModifiers: Modifier[] = [];
    let afterContainer = content.substring(i);
    
    while (afterContainer.trim().startsWith('.')) {
        const modMatch = afterContainer.trim().match(/^\.(\w+)\(([^)]*)\)/);
        if (modMatch) {
            const modName = modMatch[1];
            const modArgs = modMatch[2];
            const args: Record<string, any> = {};
            
            if (modName === 'padding' && modArgs) {
                const num = parseFloat(modArgs);
                if (!isNaN(num)) args.all = num;
                else if (!modArgs) args.all = 16;
            } else if (modName === 'frame' && modArgs) {
                const widthMatch = modArgs.match(/width:\s*(\d+)/);
                const heightMatch = modArgs.match(/height:\s*(\d+)/);
                if (widthMatch) args.width = parseInt(widthMatch[1]);
                if (heightMatch) args.height = parseInt(heightMatch[1]);
            } else if (modName === 'shadow' && modArgs) {
                const radiusMatch = modArgs.match(/radius:\s*([\d.]+)/);
                if (radiusMatch) {
                    args.radius = parseFloat(radiusMatch[1]);
                } else if (modArgs === '') {
                    args.radius = 8;
                }
            } else if (modName === 'cornerRadius' && modArgs) {
                const num = parseFloat(modArgs);
                if (!isNaN(num)) args.radius = num;
            } else if (modName === 'opacity' && modArgs) {
                const num = parseFloat(modArgs);
                if (!isNaN(num)) args.value = num;
            } else if (modName === 'blur' && modArgs) {
                const radiusMatch = modArgs.match(/radius:\s*([\d.]+)/);
                if (radiusMatch) args.radius = parseFloat(radiusMatch[1]);
            } else if (modName === 'background' && modArgs) {
                const materialMatch = modArgs.match(/\.(ultraThin|thin|regular)Material/);
                const colorMatch = modArgs.match(/Color\.(\w+)/);
                if (materialMatch) {
                    args.material = materialMatch[1];
                } else if (colorMatch) {
                    args.color = colorMatch[1];
                }
            }
            
            stackModifiers.push({ name: modName, args });
            afterContainer = afterContainer.substring(afterContainer.indexOf(modMatch[0]) + modMatch[0].length);
        } else {
            break;
        }
    }
    
    return {
        kind,
        props: stackProps,
        modifiers: stackModifiers,
        children
    };
}

/**
 * Find the end position of a closure block
 */
function findClosureEnd(content: string): number {
    const openBrace = content.indexOf('{');
    if (openBrace === -1) return content.length;
    
    let braceCount = 1;
    let pos = openBrace + 1;
    
    while (braceCount > 0 && pos < content.length) {
        if (content[pos] === '{') braceCount++;
        if (content[pos] === '}') braceCount--;
        pos++;
    }
    
    return pos;
}

/**
 * Skip past view declaration and any trailing modifiers
 * Returns the total length to skip
 */
function skipModifiers(content: string, baseLength: number): number {
    let pos = baseLength;
    
    // Look for chained modifiers starting with .
    while (pos < content.length) {
        const remaining = content.substring(pos).trim();
        const whitespaceSkip = content.substring(pos).indexOf(remaining[0]);
        pos += whitespaceSkip;
        
        if (remaining.startsWith('.')) {
            // Match modifier like .padding() or .font(.title)
            const modMatch = remaining.match(/^\.(\w+)(\([^)]*\))?/);
            if (modMatch) {
                pos += modMatch[0].length;
            } else {
                break;
            }
        } else {
            break;
        }
    }
    
    return pos;
}

/**
 * Find the end position of a view including its modifiers
 */
function findViewEnd(content: string): number {
    // Find the end of the view declaration (could be ) or })
    let pos = 0;
    let parenCount = 0;
    let braceCount = 0;
    let inString = false;
    
    for (let i = 0; i < content.length; i++) {
        const char = content[i];
        
        if (char === '"' && content[i-1] !== '\\') {
            inString = !inString;
        }
        
        if (!inString) {
            if (char === '(') parenCount++;
            if (char === ')') parenCount--;
            if (char === '{') braceCount++;
            if (char === '}') braceCount--;
            
            // If we've closed all parens and braces, check for modifiers
            if (parenCount === 0 && braceCount === 0 && i > 0) {
                pos = i + 1;
                // Look for modifiers
                while (pos < content.length) {
                    const remaining = content.substring(pos).trim();
                    if (remaining.startsWith('.')) {
                        // Skip the modifier
                        const modMatch = remaining.match(/^\.(\w+)(\([^)]*\))?/);
                        if (modMatch) {
                            pos += content.substring(pos).indexOf(modMatch[0]) + modMatch[0].length;
                        } else {
                            break;
                        }
                    } else {
                        break;
                    }
                }
                return pos;
            }
        }
    }
    
    return content.length;
}

/**
 * Parse ForEach with regex
 */
function parseRegexForEach(content: string): ViewNode | null {
    const props: Record<string, any> = {};
    
    // Try to extract range: ForEach(1..<4)
    const rangeMatch = content.match(/ForEach\s*\(\s*(\d+)\s*\.\.<?(\d+)\s*\)/);
    if (rangeMatch) {
        const start = parseInt(rangeMatch[1]);
        const end = parseInt(rangeMatch[2]);
        props.forEachRange = { start, end: content.includes('..<') ? end : end + 1 };
    }
    
    // Try to extract array: ForEach(["One", "Two", "Three"]
    const arrayMatch = content.match(/ForEach\s*\(\s*\[([^\]]+)\]/);
    if (arrayMatch) {
        const stringMatches = arrayMatch[1].match(/"([^"]+)"/g);
        if (stringMatches) {
            props.forEachItems = stringMatches.map(s => s.replace(/"/g, ''));
        }
    }
    
    // Try to extract row template (very simple - just Text for now)
    const closureMatch = content.match(/\{\s*\w+\s+in\s+(.*?)\s*\}/s);
    if (closureMatch) {
        const textMatch = closureMatch[1].match(/Text\("([^"]+)"\)/);
        if (textMatch) {
            // Parse modifiers on the Text
            let textNode: ViewNode = {
                kind: 'Text',
                props: { text: textMatch[1] },
                modifiers: [],
                children: []
            };
            
            // Look for modifiers
            const modifierText = closureMatch[1].substring(closureMatch[1].indexOf(textMatch[0]) + textMatch[0].length);
            const paddingMatch = modifierText.match(/\.padding\((\d+)\)/);
            if (paddingMatch) {
                textNode.modifiers.push({ name: 'padding', args: { all: parseInt(paddingMatch[1]) } });
            }
            
            props.rowTemplate = textNode;
        }
    }
    
    return {
        kind: 'ForEach',
        props,
        modifiers: [],
        children: []
    };
}
