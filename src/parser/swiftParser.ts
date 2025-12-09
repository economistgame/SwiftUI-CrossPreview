import { ViewNode, Modifier } from './viewTree';

// Try to load tree-sitter, but provide fallback if native modules fail
let Parser: any = null;
let Swift: any = null;
let useTreeSitter = true;

try {
    Parser = require('tree-sitter');
    Swift = require('tree-sitter-swift');
} catch (error) {
    console.warn('Tree-sitter native modules not available, using regex fallback parser:', error);
    useTreeSitter = false;
}

// Singleton parser instance
let parser: any = null;

function getParser(): any {
    if (!parser && useTreeSitter && Parser && Swift) {
        parser = new Parser();
        parser.setLanguage(Swift);
    }
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
    
    // Try tree-sitter first if available
    const p = getParser();
    if (p) {
        try {
            return parseWithTreeSitter(source);
        } catch (error) {
            console.warn('Tree-sitter parsing failed, falling back to regex parser:', error);
            // Fall through to regex parser
        }
    }
    
    // Use regex fallback
    return parseWithRegex(source);
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
 * Parse using tree-sitter (preferred method)
 */
function parseWithTreeSitter(source: string): ParseResult {
    const errors: string[] = [];
    
    try {
        const tree = getParser().parse(source);
        const root = tree.rootNode;

        // Find a struct that conforms to View
        const viewStruct = findViewStruct(root);
        if (!viewStruct) {
            errors.push('No struct conforming to View protocol found');
            return { root: null, errors };
        }

        // Find the body property
        const bodyProperty = findBodyProperty(viewStruct);
        if (!bodyProperty) {
            errors.push('No "var body: some View" property found in View struct');
            return { root: null, errors };
        }

        // Extract the main expression from body
        const bodyExpression = findBodyExpression(bodyProperty);
        if (!bodyExpression) {
            errors.push('Could not extract expression from body property');
            return { root: null, errors };
        }

        // Convert to ViewNode
        const viewNode = parseViewExpression(bodyExpression, source);
        if (!viewNode) {
            errors.push('Body expression is not a supported SwiftUI view (expected VStack with Text children)');
            return { root: null, errors };
        }

        // Extract state properties from the struct
        const stateProperties = extractStateProperties(viewStruct);
        if (stateProperties.length > 0) {
            viewNode.stateProperties = stateProperties;
        }

        return { root: viewNode, errors };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push(`Parser exception: ${errorMsg}`);
        console.error('Failed to parse Swift code:', error);
        return { root: null, errors };
    }
}

/**
 * Extract @State, @Binding, and other property wrappers from a View struct
 */
function extractStateProperties(structNode: any): Array<{name: string, type: "State" | "Binding" | "StateObject" | "ObservedObject" | "EnvironmentObject" | "Environment", valueType?: string, initialValue?: any}> {
    const properties: Array<{name: string, type: "State" | "Binding" | "StateObject" | "ObservedObject" | "EnvironmentObject" | "Environment", valueType?: string, initialValue?: any}> = [];
    
    for (const child of structNode.children) {
        if (child.type === 'property_declaration' || child.type === 'variable_declaration') {
            // Look for modifiers (attributes) like @State, @Binding
            const modifiers = child.children.filter((c: any) => c.type === 'modifiers' || c.type === 'attribute');
            let propertyWrapperType: "State" | "Binding" | "StateObject" | "ObservedObject" | "EnvironmentObject" | "Environment" | null = null;
            
            for (const modifier of modifiers) {
                const text = modifier.text;
                if (text.includes('@State')) propertyWrapperType = 'State';
                else if (text.includes('@Binding')) propertyWrapperType = 'Binding';
                else if (text.includes('@StateObject')) propertyWrapperType = 'StateObject';
                else if (text.includes('@ObservedObject')) propertyWrapperType = 'ObservedObject';
                else if (text.includes('@EnvironmentObject')) propertyWrapperType = 'EnvironmentObject';
                else if (text.includes('@Environment')) propertyWrapperType = 'Environment';
            }
            
            if (propertyWrapperType) {
                // Extract property name
                const patternNode = child.children.find((c: any) => c.type === 'pattern' || c.type === 'simple_identifier');
                const nameNode = patternNode?.children?.find((c: any) => c.type === 'simple_identifier') || patternNode;
                const propertyName = nameNode?.text || 'unknown';
                
                // Extract type annotation if present
                const typeAnnotation = child.children.find((c: any) => c.type === 'type_annotation');
                let valueType: string | undefined;
                if (typeAnnotation) {
                    const typeNode = typeAnnotation.children.find((c: any) => c.type !== ':');
                    valueType = typeNode?.text;
                }
                
                // Extract initial value if present
                let initialValue: any;
                const equalityNode = child.children.find((c: any) => c.type === 'equal_sign' || c.text === '=');
                if (equalityNode) {
                    const valueIndex = child.children.indexOf(equalityNode) + 1;
                    if (valueIndex < child.children.length) {
                        const valueNode = child.children[valueIndex];
                        initialValue = extractInitialValue(valueNode);
                    }
                }
                
                properties.push({
                    name: propertyName,
                    type: propertyWrapperType,
                    valueType,
                    initialValue
                });
            }
        }
    }
    
    return properties;
}

/**
 * Extract initial value from a node
 */
function extractInitialValue(node: any): any {
    if (node.type === 'boolean_literal') {
        return node.text === 'true';
    }
    if (node.type === 'integer_literal') {
        return parseInt(node.text);
    }
    if (node.type === 'float_literal') {
        return parseFloat(node.text);
    }
    if (node.type === 'string_literal') {
        const match = node.text.match(/"([^"]*)"/);
        return match ? match[1] : node.text;
    }
    return node.text;
}

/**
 * Find a struct declaration that conforms to View protocol
 */
function findViewStruct(node: any): any {
    if (node.type === 'class_declaration' || node.type === 'struct_declaration') {
        // Check if it has "View" in type inheritance
        const inheritanceClause = node.children.find((c: any) => c.type === 'type_inheritance_clause');
        if (inheritanceClause) {
            const text = inheritanceClause.text;
            if (text.includes('View')) {
                return node;
            }
        }
    }

    // Recursively search children
    for (const child of node.children) {
        const result = findViewStruct(child);
        if (result) {
            return result;
        }
    }

    return null;
}

/**
 * Find the body property in a View struct
 */
function findBodyProperty(structNode: any): any {
    // Look for computed_property or variable_declaration named "body"
    for (const child of structNode.children) {
        if (child.type === 'computed_property' || child.type === 'variable_declaration') {
            const nameNode = child.children.find((c: any) => c.type === 'simple_identifier' || c.type === 'pattern');
            if (nameNode && nameNode.text === 'body') {
                return child;
            }
        }
    }
    return null;
}

/**
 * Extract the main expression from the body property
 */
function findBodyExpression(bodyNode: any): any {
    // Look for getter or direct expression
    for (const child of bodyNode.children) {
        if (child.type === 'getter') {
            // Find the return expression or direct statement
            for (const getterChild of child.children) {
                if (getterChild.type === 'statements') {
                    // Get first statement
                    const statement = getterChild.children.find((c: any) => c.type !== '{' && c.type !== '}');
                    if (statement) {
                        return statement;
                    }
                }
            }
        }
    }
    return null;
}

/**
 * Parse a SwiftUI view expression into a ViewNode
 */
function parseViewExpression(node: any, source: string): ViewNode | null {
    // Handle call_expression (e.g., VStack { ... })
    if (node.type === 'call_expression') {
        return parseCallExpression(node, source);
    }

    // Handle postfix_expression (e.g., VStack { ... }.padding())
    if (node.type === 'postfix_expression') {
        return parsePostfixExpression(node, source);
    }

    // Handle simple identifier
    if (node.type === 'simple_identifier') {
        const name = node.text;
        if (name === 'Spacer') {
            return {
                kind: 'Spacer',
                props: {},
                modifiers: [],
                children: []
            };
        }
    }

    return null;
}

/**
 * Parse a call expression (e.g., VStack { ... }, Text("Hello"))
 */
function parseCallExpression(node: any, source: string): ViewNode | null {
    const functionNode = node.children.find((c: any) => c.type === 'simple_identifier' || c.type === 'navigation_expression');
    const functionName = functionNode?.text || '';
    
    // Handle container views: VStack, HStack, ZStack
    if (functionName === 'VStack' || functionName === 'HStack' || functionName === 'ZStack') {
        const kind = functionName as "VStack" | "HStack" | "ZStack";
        const props: Record<string, any> = {};
        const children: ViewNode[] = [];

        // Look for closure argument with children
        const args = node.children.find((c: any) => c.type === 'call_suffix' || c.type === 'lambda_literal');
        if (args) {
            // Parse alignment and spacing from value_arguments
            const valueArgs = args.children.filter((c: any) => c.type === 'value_argument');
            for (const valueArg of valueArgs) {
                const label = valueArg.children.find((c: any) => c.type === 'value_argument_label');
                const value = valueArg.children.find((c: any) => 
                    c.type === 'navigation_expression' || 
                    c.type === 'integer_literal' ||
                    c.type === 'float_literal'
                );
                
                if (label && value) {
                    const labelText = label.text.replace(':', '');
                    if (labelText === 'alignment') {
                        const alignValue = extractEnumValue(value);
                        if (alignValue) {
                            props.alignment = alignValue;
                        }
                    } else if (labelText === 'spacing') {
                        if (value.type === 'integer_literal' || value.type === 'float_literal') {
                            props.spacing = parseFloat(value.text);
                        }
                    }
                }
            }
            
            // Find closure/trailing closure
            for (const arg of args.children) {
                if (arg.type === 'lambda_literal' || arg.type === 'closure_expression') {
                    const statements = findStatementsInClosure(arg);
                    for (const stmt of statements) {
                        const child = parseViewExpression(stmt, source);
                        if (child) {
                            children.push(child);
                        }
                    }
                }
            }
        }

        return {
            kind,
            props,
            modifiers: [],
            children
        };
    }

    // Handle Text("...")
    if (functionName === 'Text') {
        const args = node.children.find((c: any) => c.type === 'call_suffix');
        let text = '';
        
        if (args) {
            // Find string literal
            for (const arg of args.children) {
                if (arg.type === 'line_string_literal' || arg.type === 'string_literal') {
                    // Extract text without quotes
                    text = arg.text.replace(/^"/, '').replace(/"$/, '');
                    break;
                }
            }
        }

        return {
            kind: 'Text',
            props: { text },
            modifiers: [],
            children: []
        };
    }

    // Handle Image("...")
    if (functionName === 'Image') {
        const args = node.children.find((c: any) => c.type === 'call_suffix');
        let name = '';
        
        if (args) {
            for (const arg of args.children) {
                if (arg.type === 'line_string_literal' || arg.type === 'string_literal') {
                    name = arg.text.replace(/^"/, '').replace(/"$/, '');
                    break;
                }
            }
        }

        return {
            kind: 'Image',
            props: { name },
            modifiers: [],
            children: []
        };
    }

    // Handle List { ... }
    if (functionName === 'List') {
        return parseContainerView(node, 'List', source);
    }

    // Handle Form { ... }
    if (functionName === 'Form') {
        return parseContainerView(node, 'Form', source);
    }

    // Handle Section(header: Text("...")) { ... }
    if (functionName === 'Section') {
        const props: Record<string, any> = {};
        const children: ViewNode[] = [];
        
        const args = node.children.find((c: any) => c.type === 'call_suffix' || c.type === 'lambda_literal');
        if (args) {
            // Look for header argument
            const valueArgs = args.children.filter((c: any) => c.type === 'value_argument');
            for (const valueArg of valueArgs) {
                const label = valueArg.children.find((c: any) => c.type === 'value_argument_label');
                if (label && label.text.includes('header')) {
                    const headerExpr = valueArg.children.find((c: any) => 
                        c.type === 'call_expression' || c.type === 'postfix_expression'
                    );
                    if (headerExpr) {
                        const headerNode = parseViewExpression(headerExpr, source);
                        if (headerNode) {
                            props.header = headerNode;
                        }
                    }
                }
            }
            
            // Find closure/trailing closure for body
            for (const arg of args.children) {
                if (arg.type === 'lambda_literal' || arg.type === 'closure_expression') {
                    const statements = findStatementsInClosure(arg);
                    for (const stmt of statements) {
                        const child = parseViewExpression(stmt, source);
                        if (child) {
                            children.push(child);
                        }
                    }
                }
            }
        }
        
        return {
            kind: 'Section',
            props,
            modifiers: [],
            children
        };
    }

    // Handle ScrollView { ... } or ScrollView(.vertical) { ... }
    if (functionName === 'ScrollView') {
        return parseContainerView(node, 'ScrollView', source);
    }

    // Handle ForEach patterns
    if (functionName === 'ForEach') {
        return parseForEach(node, source);
    }

    // Handle Button
    if (functionName === 'Button') {
        return parseButton(node, source);
    }

    // Handle Toggle
    if (functionName === 'Toggle') {
        return parseToggle(node, source);
    }

    // Handle Picker
    if (functionName === 'Picker') {
        return parsePicker(node, source);
    }

    // Handle LinearGradient
    if (functionName === 'LinearGradient') {
        return parseLinearGradient(node, source);
    }

    // Handle RadialGradient
    if (functionName === 'RadialGradient') {
        return parseRadialGradient(node, source);
    }

    // Handle TextField
    if (functionName === 'TextField') {
        return parseTextField(node, source, false);
    }

    // Handle SecureField
    if (functionName === 'SecureField') {
        return parseTextField(node, source, true);
    }

    // Handle shapes
    if (functionName === 'Rectangle') {
        return { kind: 'Rectangle', props: {}, modifiers: [], children: [] };
    }
    if (functionName === 'Circle') {
        return { kind: 'Circle', props: {}, modifiers: [], children: [] };
    }
    if (functionName === 'RoundedRectangle') {
        return parseRoundedRectangle(node, source);
    }
    if (functionName === 'Capsule') {
        return { kind: 'Capsule', props: {}, modifiers: [], children: [] };
    }
    if (functionName === 'Ellipse') {
        return { kind: 'Ellipse', props: {}, modifiers: [], children: [] };
    }

    // Handle Divider
    if (functionName === 'Divider') {
        return { kind: 'Divider', props: {}, modifiers: [], children: [] };
    }

    // Handle Label
    if (functionName === 'Label') {
        return parseLabel(node, source);
    }

    // Handle Slider
    if (functionName === 'Slider') {
        return parseSlider(node, source);
    }

    // Handle Stepper
    if (functionName === 'Stepper') {
        return parseStepper(node, source);
    }

    // Handle DatePicker
    if (functionName === 'DatePicker') {
        return parseDatePicker(node, source);
    }

    // Handle ColorPicker
    if (functionName === 'ColorPicker') {
        return parseColorPicker(node, source);
    }

    // Handle ProgressView
    if (functionName === 'ProgressView') {
        return parseProgressView(node, source);
    }

    // Handle Link
    if (functionName === 'Link') {
        return parseLink(node, source);
    }

    // Handle Menu
    if (functionName === 'Menu') {
        return parseMenu(node, source);
    }

    // Handle LazyVStack
    if (functionName === 'LazyVStack') {
        return parseContainerView(node, 'LazyVStack', source);
    }

    // Handle LazyHStack
    if (functionName === 'LazyHStack') {
        return parseContainerView(node, 'LazyHStack', source);
    }

    // Handle Grid
    if (functionName === 'Grid') {
        return parseContainerView(node, 'Grid', source);
    }

    // Handle Group
    if (functionName === 'Group') {
        return parseContainerView(node, 'Group', source);
    }

    // Handle GeometryReader
    if (functionName === 'GeometryReader') {
        return parseContainerView(node, 'GeometryReader', source);
    }

    // Handle NavigationView
    if (functionName === 'NavigationView') {
        return parseNavigationView(node, source);
    }

    // Handle NavigationStack
    if (functionName === 'NavigationStack') {
        return parseNavigationStack(node, source);
    }

    // Handle NavigationLink
    if (functionName === 'NavigationLink') {
        return parseNavigationLink(node, source);
    }

    // Handle TabView
    if (functionName === 'TabView') {
        return parseTabView(node, source);
    }

    // Handle AsyncImage
    if (functionName === 'AsyncImage') {
        return parseAsyncImage(node, source);
    }

    // Handle TextEditor
    if (functionName === 'TextEditor') {
        return parseTextEditor(node, source);
    }

    // Handle DisclosureGroup
    if (functionName === 'DisclosureGroup') {
        return parseDisclosureGroup(node, source);
    }

    // Fallback: Handle custom views (like HomeDashboardView(), SettingsFormView(), etc.)
    // Treat them as Group containers with a placeholder
    if (functionName && /^[A-Z][a-zA-Z0-9]*View$/.test(functionName)) {
        return {
            kind: 'Group',
            props: { customView: functionName },
            modifiers: [],
            children: [{
                kind: 'Text',
                props: { text: `<${functionName}>` },
                modifiers: [],
                children: []
            }]
        };
    }

    return null;
}

/**
 * Helper to parse container views (List, Form, ScrollView, LazyVStack, LazyHStack, Grid, Group, GeometryReader)
 */
function parseContainerView(node: any, kind: "List" | "Form" | "ScrollView" | "LazyVStack" | "LazyHStack" | "LazyVGrid" | "LazyHGrid" | "Grid" | "Group" | "GeometryReader", source: string): ViewNode {
    const children: ViewNode[] = [];
    const args = node.children.find((c: any) => c.type === 'call_suffix' || c.type === 'lambda_literal');
    
    if (args) {
        for (const arg of args.children) {
            if (arg.type === 'lambda_literal' || arg.type === 'closure_expression') {
                const statements = findStatementsInClosure(arg);
                for (const stmt of statements) {
                    const child = parseViewExpression(stmt, source);
                    if (child) {
                        children.push(child);
                    }
                }
            }
        }
    }
    
    return {
        kind,
        props: {},
        modifiers: [],
        children
    };
}

/**
 * Parse ForEach patterns
 */
function parseForEach(node: any, source: string): ViewNode {
    const props: Record<string, any> = {};
    let rowTemplate: ViewNode | null = null;
    
    const args = node.children.find((c: any) => c.type === 'call_suffix');
    
    if (args) {
        // Look for the first argument (range or array)
        const valueArgs = args.children.filter((c: any) => 
            c.type === 'value_argument' || 
            c.type === 'binary_expression' ||
            c.type === 'array_literal' ||
            c.type === 'integer_literal'
        );
        
        for (const arg of valueArgs) {
            // Check for range expression like 1..<4
            if (arg.type === 'binary_expression' || arg.text?.includes('..<') || arg.text?.includes('...')) {
                const rangeText = arg.text || '';
                const rangeMatch = rangeText.match(/(\d+)\s*\.\.<?(\d+)/);
                if (rangeMatch) {
                    const start = parseInt(rangeMatch[1]);
                    const end = parseInt(rangeMatch[2]);
                    props.forEachRange = { start, end: rangeMatch[0].includes('..<') ? end : end + 1 };
                    break;
                }
            }
            
            // Check for array literal
            if (arg.type === 'array_literal' || arg.type === 'value_argument') {
                const arrayText = arg.text || '';
                const stringMatches = arrayText.match(/"([^"]+)"/g);
                if (stringMatches && stringMatches.length > 0) {
                    props.forEachItems = stringMatches.map((s: string) => s.replace(/"/g, ''));
                    break;
                }
                // Check for property reference like "cards" or "items"
                if (arg.type === 'value_argument') {
                    const valueArg = arg.children.find((c: any) => c.type === 'simple_identifier');
                    if (valueArg) {
                        const propName = valueArg.text;
                        // Generate placeholder items
                        props.forEachItems = [`Item 1`, `Item 2`, `Item 3`];
                        props.arrayProperty = propName;
                        break;
                    }
                }
            }
        }
        
        // Find trailing closure for row template
        for (const arg of args.children) {
            if (arg.type === 'lambda_literal' || arg.type === 'closure_expression') {
                const statements = findStatementsInClosure(arg);
                if (statements.length > 0) {
                    rowTemplate = parseViewExpression(statements[0], source);
                    if (rowTemplate) {
                        props.rowTemplate = rowTemplate;
                    }
                }
                break;
            }
        }
    }
    
    return {
        kind: 'ForEach',
        props,
        modifiers: [],
        children: [] // Children will be expanded by renderer
    };
}

/**
 * Parse Button
 */
function parseButton(node: any, source: string): ViewNode {
    const props: Record<string, any> = {};
    const children: ViewNode[] = [];
    
    const args = node.children.find((c: any) => c.type === 'call_suffix');
    
    if (args) {
        // Look for action closure and label
        let hasAction = false;
        
        for (const arg of args.children) {
            // Check for "action:" labeled argument
            if (arg.type === 'value_argument') {
                const label = arg.children.find((c: any) => c.type === 'value_argument_label');
                if (label && label.text.includes('action')) {
                    hasAction = true;
                    props.action = 'action';
                }
            }
            
            // Find label closure
            if (arg.type === 'lambda_literal' || arg.type === 'closure_expression') {
                if (hasAction) {
                    // This is the label closure
                    const statements = findStatementsInClosure(arg);
                    for (const stmt of statements) {
                        const child = parseViewExpression(stmt, source);
                        if (child) {
                            children.push(child);
                        }
                    }
                } else {
                    // First closure is action
                    hasAction = true;
                    props.action = 'action';
                }
            }
        }
        
        // Look for string literal label (can be direct or inside value_argument)
        for (const arg of args.children) {
            if (arg.type === 'line_string_literal' || arg.type === 'string_literal') {
                const text = arg.text.replace(/^"|"$/g, '');
                children.push({
                    kind: 'Text',
                    props: { text },
                    modifiers: [],
                    children: []
                });
                break;
            }
            
            // Check inside value_argument for string literals
            if (arg.type === 'value_argument') {
                const stringLiteral = arg.children.find((c: any) => 
                    c.type === 'line_string_literal' || c.type === 'string_literal'
                );
                if (stringLiteral) {
                    const text = stringLiteral.text.replace(/^"|"$/g, '');
                    children.push({
                        kind: 'Text',
                        props: { text },
                        modifiers: [],
                        children: []
                    });
                    break;
                }
            }
        }
    }
    
    return {
        kind: 'Button',
        props,
        modifiers: [],
        children
    };
}

/**
 * Parse Toggle
 */
function parseToggle(node: any, source: string): ViewNode {
    const props: Record<string, any> = {};
    
    const args = node.children.find((c: any) => c.type === 'call_suffix');
    
    if (args) {
        // Look for label (string or closure)
        for (const arg of args.children) {
            if (arg.type === 'line_string_literal' || arg.type === 'string_literal') {
                props.label = arg.text.replace(/^"|"$/g, '');
                break;
            }
        }
        
        // Look for isOn binding
        for (const arg of args.children) {
            if (arg.type === 'value_argument') {
                const label = arg.children.find((c: any) => c.type === 'value_argument_label');
                if (label && label.text.includes('isOn')) {
                    props.isOn = true;
                }
            }
        }
    }
    
    return {
        kind: 'Toggle',
        props,
        modifiers: [],
        children: []
    };
}

/**
 * Parse Picker
 */
function parsePicker(node: any, source: string): ViewNode {
    const props: Record<string, any> = {};
    const children: ViewNode[] = [];
    
    const args = node.children.find((c: any) => c.type === 'call_suffix');
    
    if (args) {
        // Look for label
        for (const arg of args.children) {
            if (arg.type === 'line_string_literal' || arg.type === 'string_literal') {
                props.label = arg.text.replace(/^"|"$/g, '');
                break;
            }
        }
        
        // Look for selection binding
        for (const arg of args.children) {
            if (arg.type === 'value_argument') {
                const label = arg.children.find((c: any) => c.type === 'value_argument_label');
                if (label && label.text.includes('selection')) {
                    props.selection = 'binding';
                }
            }
        }
        
        // Find content closure
        for (const arg of args.children) {
            if (arg.type === 'lambda_literal' || arg.type === 'closure_expression') {
                const statements = findStatementsInClosure(arg);
                for (const stmt of statements) {
                    const child = parseViewExpression(stmt, source);
                    if (child) {
                        children.push(child);
                    }
                }
            }
        }
    }
    
    return {
        kind: 'Picker',
        props,
        modifiers: [],
        children
    };
}

/**
 * Parse LinearGradient
 */
function parseLinearGradient(node: any, source: string): ViewNode {
    const props: Record<string, any> = {
        colors: [],
        startPoint: 'top',
        endPoint: 'bottom'
    };
    
    const args = node.children.find((c: any) => c.type === 'call_suffix');
    
    if (args) {
        // Look for gradient parameter (deprecated) or colors array
        for (const arg of args.children) {
            if (arg.type === 'value_argument') {
                const label = arg.children.find((c: any) => c.type === 'value_argument_label');
                
                // Parse colors array
                if (label && (label.text.includes('colors') || label.text.includes('gradient'))) {
                    const arrayArg = arg.children.find((c: any) => c.type === 'array_literal');
                    if (arrayArg) {
                        const colorMatches = arrayArg.text.match(/\.([a-z]+)/gi);
                        if (colorMatches) {
                            props.colors = colorMatches.map((m: string) => m.substring(1));
                        }
                    }
                }
                
                // Parse startPoint
                if (label && label.text.includes('startPoint')) {
                    const pointMatch = arg.text.match(/\.(top|bottom|leading|trailing|topLeading|topTrailing|bottomLeading|bottomTrailing)/i);
                    if (pointMatch) {
                        props.startPoint = pointMatch[1];
                    }
                }
                
                // Parse endPoint
                if (label && label.text.includes('endPoint')) {
                    const pointMatch = arg.text.match(/\.(top|bottom|leading|trailing|topLeading|topTrailing|bottomLeading|bottomTrailing)/i);
                    if (pointMatch) {
                        props.endPoint = pointMatch[1];
                    }
                }
            }
        }
    }
    
    return {
        kind: 'LinearGradient',
        props,
        modifiers: [],
        children: []
    };
}

/**
 * Parse RadialGradient
 */
function parseRadialGradient(node: any, source: string): ViewNode {
    const props: Record<string, any> = {
        colors: [],
        center: 'center',
        startRadius: 0,
        endRadius: 100
    };
    
    const args = node.children.find((c: any) => c.type === 'call_suffix');
    
    if (args) {
        for (const arg of args.children) {
            if (arg.type === 'value_argument') {
                const label = arg.children.find((c: any) => c.type === 'value_argument_label');
                
                // Parse colors
                if (label && (label.text.includes('colors') || label.text.includes('gradient'))) {
                    const arrayArg = arg.children.find((c: any) => c.type === 'array_literal');
                    if (arrayArg) {
                        const colorMatches = arrayArg.text.match(/\.([a-z]+)/gi);
                        if (colorMatches) {
                            props.colors = colorMatches.map((m: string) => m.substring(1));
                        }
                    }
                }
                
                // Parse center
                if (label && label.text.includes('center')) {
                    const centerMatch = arg.text.match(/\.([a-z]+)/i);
                    if (centerMatch) {
                        props.center = centerMatch[1];
                    }
                }
            }
        }
    }
    
    return {
        kind: 'RadialGradient',
        props,
        modifiers: [],
        children: []
    };
}

/**
 * Parse TextField or SecureField
 */
function parseTextField(node: any, source: string, isSecure: boolean): ViewNode {
    const props: Record<string, any> = {
        placeholder: '',
        text: ''
    };
    
    const args = node.children.find((c: any) => c.type === 'call_suffix');
    
    if (args) {
        const valueArgs = args.children.filter((c: any) => c.type === 'value_argument');
        
        // First argument is usually the placeholder
        if (valueArgs.length > 0) {
            const firstArg = valueArgs[0];
            const stringLiteral = firstArg.children.find((c: any) => 
                c.type === 'line_string_literal' || c.type === 'string_literal'
            );
            if (stringLiteral) {
                props.placeholder = stringLiteral.text.replace(/^"/, '').replace(/"$/, '');
            }
        }
    }
    
    return {
        kind: isSecure ? 'SecureField' : 'TextField',
        props,
        modifiers: [],
        children: []
    };
}

/**
 * Parse RoundedRectangle
 */
function parseRoundedRectangle(node: any, source: string): ViewNode {
    const props: Record<string, any> = {
        cornerRadius: 8
    };
    
    const args = node.children.find((c: any) => c.type === 'call_suffix');
    
    if (args) {
        for (const arg of args.children) {
            if (arg.type === 'value_argument') {
                const label = arg.children.find((c: any) => c.type === 'value_argument_label');
                
                if (label && label.text.includes('cornerRadius')) {
                    const numberMatch = arg.text.match(/(\d+)/);
                    if (numberMatch) {
                        props.cornerRadius = parseInt(numberMatch[1]);
                    }
                }
            }
        }
    }
    
    return {
        kind: 'RoundedRectangle',
        props,
        modifiers: [],
        children: []
    };
}

/**
 * Parse Label
 */
function parseLabel(node: any, source: string): ViewNode {
    const props: Record<string, any> = {
        title: '',
        systemImage: ''
    };
    
    const args = node.children.find((c: any) => c.type === 'call_suffix');
    
    if (args) {
        const valueArgs = args.children.filter((c: any) => c.type === 'value_argument');
        
        for (const arg of valueArgs) {
            const label = arg.children.find((c: any) => c.type === 'value_argument_label');
            const stringLiteral = arg.children.find((c: any) => 
                c.type === 'line_string_literal' || c.type === 'string_literal'
            );
            
            if (label && stringLiteral) {
                const value = stringLiteral.text.replace(/^"/, '').replace(/"$/, '');
                
                if (label.text === 'title:') {
                    props.title = value;
                } else if (label.text === 'systemImage:') {
                    props.systemImage = value;
                }
            }
        }
    }
    
    return {
        kind: 'Label',
        props,
        modifiers: [],
        children: []
    };
}

/**
 * Parse Slider
 */
function parseSlider(node: any, source: string): ViewNode {
    const props: Record<string, any> = {
        value: 0.5,
        range: [0, 1]
    };
    
    const args = node.children.find((c: any) => c.type === 'call_suffix');
    if (args) {
        // Try to extract range from arguments
        const rangeMatch = args.text.match(/in:\s*(\d+)\.\.\.?(\d+)/);
        if (rangeMatch) {
            props.range = [parseFloat(rangeMatch[1]), parseFloat(rangeMatch[2])];
        }
    }
    
    return {
        kind: 'Slider',
        props,
        modifiers: [],
        children: []
    };
}

/**
 * Parse Stepper
 */
function parseStepper(node: any, source: string): ViewNode {
    const props: Record<string, any> = {
        label: 'Stepper',
        value: 0
    };
    
    const args = node.children.find((c: any) => c.type === 'call_suffix');
    if (args) {
        const valueArgs = args.children.filter((c: any) => c.type === 'value_argument');
        
        for (const arg of valueArgs) {
            const stringLiteral = arg.children.find((c: any) => 
                c.type === 'line_string_literal' || c.type === 'string_literal'
            );
            if (stringLiteral) {
                props.label = stringLiteral.text.replace(/^"/, '').replace(/"$/, '');
                break;
            }
        }
    }
    
    return {
        kind: 'Stepper',
        props,
        modifiers: [],
        children: []
    };
}

/**
 * Parse DatePicker
 */
function parseDatePicker(node: any, source: string): ViewNode {
    const props: Record<string, any> = {
        label: 'Date'
    };
    
    const args = node.children.find((c: any) => c.type === 'call_suffix');
    if (args) {
        const valueArgs = args.children.filter((c: any) => c.type === 'value_argument');
        
        for (const arg of valueArgs) {
            const stringLiteral = arg.children.find((c: any) => 
                c.type === 'line_string_literal' || c.type === 'string_literal'
            );
            if (stringLiteral) {
                props.label = stringLiteral.text.replace(/^"/, '').replace(/"$/, '');
                break;
            }
        }
    }
    
    return {
        kind: 'DatePicker',
        props,
        modifiers: [],
        children: []
    };
}

/**
 * Parse ColorPicker
 */
function parseColorPicker(node: any, source: string): ViewNode {
    const props: Record<string, any> = {
        label: 'Color'
    };
    
    const args = node.children.find((c: any) => c.type === 'call_suffix');
    if (args) {
        const valueArgs = args.children.filter((c: any) => c.type === 'value_argument');
        
        for (const arg of valueArgs) {
            const stringLiteral = arg.children.find((c: any) => 
                c.type === 'line_string_literal' || c.type === 'string_literal'
            );
            if (stringLiteral) {
                props.label = stringLiteral.text.replace(/^"/, '').replace(/"$/, '');
                break;
            }
        }
    }
    
    return {
        kind: 'ColorPicker',
        props,
        modifiers: [],
        children: []
    };
}

/**
 * Parse ProgressView
 */
function parseProgressView(node: any, source: string): ViewNode {
    const props: Record<string, any> = {
        value: null
    };
    
    const args = node.children.find((c: any) => c.type === 'call_suffix');
    if (args) {
        const valueArgs = args.children.filter((c: any) => c.type === 'value_argument');
        
        for (const arg of valueArgs) {
            const label = arg.children.find((c: any) => c.type === 'value_argument_label');
            
            if (label && label.text.includes('value')) {
                const numberMatch = arg.text.match(/([\d.]+)/);
                if (numberMatch) {
                    props.value = parseFloat(numberMatch[1]);
                }
            }
        }
    }
    
    return {
        kind: 'ProgressView',
        props,
        modifiers: [],
        children: []
    };
}

/**
 * Parse Link
 */
function parseLink(node: any, source: string): ViewNode {
    const props: Record<string, any> = {
        title: 'Link',
        destination: '#'
    };
    
    const args = node.children.find((c: any) => c.type === 'call_suffix');
    if (args) {
        const valueArgs = args.children.filter((c: any) => c.type === 'value_argument');
        
        if (valueArgs.length > 0) {
            const firstArg = valueArgs[0];
            const stringLiteral = firstArg.children.find((c: any) => 
                c.type === 'line_string_literal' || c.type === 'string_literal'
            );
            if (stringLiteral) {
                props.title = stringLiteral.text.replace(/^"/, '').replace(/"$/, '');
            }
        }
        
        if (valueArgs.length > 1) {
            const secondArg = valueArgs[1];
            const label = secondArg.children.find((c: any) => c.type === 'value_argument_label');
            if (label && label.text.includes('destination')) {
                const stringLiteral = secondArg.children.find((c: any) => 
                    c.type === 'line_string_literal' || c.type === 'string_literal'
                );
                if (stringLiteral) {
                    props.destination = stringLiteral.text.replace(/^"/, '').replace(/"$/, '');
                }
            }
        }
    }
    
    return {
        kind: 'Link',
        props,
        modifiers: [],
        children: []
    };
}

/**
 * Parse Menu
 */
function parseMenu(node: any, source: string): ViewNode {
    const props: Record<string, any> = {
        label: 'Menu'
    };
    const children: ViewNode[] = [];
    
    const args = node.children.find((c: any) => c.type === 'call_suffix');
    if (args) {
        const valueArgs = args.children.filter((c: any) => c.type === 'value_argument');
        
        // First argument is usually the label
        if (valueArgs.length > 0) {
            const firstArg = valueArgs[0];
            const stringLiteral = firstArg.children.find((c: any) => 
                c.type === 'line_string_literal' || c.type === 'string_literal'
            );
            if (stringLiteral) {
                props.label = stringLiteral.text.replace(/^"/, '').replace(/"$/, '');
            }
        }
        
        // Parse menu content from closure
        for (const arg of args.children) {
            if (arg.type === 'lambda_literal' || arg.type === 'closure_expression') {
                const statements = findStatementsInClosure(arg);
                for (const stmt of statements) {
                    const child = parseViewExpression(stmt, source);
                    if (child) {
                        children.push(child);
                    }
                }
            }
        }
    }
    
    return {
        kind: 'Menu',
        props,
        modifiers: [],
        children
    };
}

/**
 * Parse NavigationView
 */
function parseNavigationView(node: any, source: string): ViewNode {
    const children: ViewNode[] = [];
    const args = node.children.find((c: any) => c.type === 'call_suffix');
    
    if (args) {
        for (const arg of args.children) {
            if (arg.type === 'lambda_literal' || arg.type === 'closure_expression') {
                const statements = findStatementsInClosure(arg);
                for (const stmt of statements) {
                    const child = parseViewExpression(stmt, source);
                    if (child) {
                        children.push(child);
                    }
                }
            }
        }
    }
    
    return {
        kind: 'NavigationView',
        props: {},
        modifiers: [],
        children
    };
}

/**
 * Parse NavigationStack (iOS 16+)
 */
function parseNavigationStack(node: any, source: string): ViewNode {
    const children: ViewNode[] = [];
    const args = node.children.find((c: any) => c.type === 'call_suffix');
    
    if (args) {
        for (const arg of args.children) {
            if (arg.type === 'lambda_literal' || arg.type === 'closure_expression') {
                const statements = findStatementsInClosure(arg);
                for (const stmt of statements) {
                    const child = parseViewExpression(stmt, source);
                    if (child) {
                        children.push(child);
                    }
                }
            }
        }
    }
    
    return {
        kind: 'NavigationStack',
        props: {},
        modifiers: [],
        children
    };
}

/**
 * Parse NavigationLink
 */
function parseNavigationLink(node: any, source: string): ViewNode {
    const props: Record<string, any> = {
        label: 'Link',
        destination: null
    };
    const children: ViewNode[] = [];
    
    const args = node.children.find((c: any) => c.type === 'call_suffix');
    if (args) {
        const valueArgs = args.children.filter((c: any) => c.type === 'value_argument');
        
        // First argument is usually the label (string or view)
        if (valueArgs.length > 0) {
            const firstArg = valueArgs[0];
            const stringLiteral = firstArg.children.find((c: any) => 
                c.type === 'line_string_literal' || c.type === 'string_literal'
            );
            if (stringLiteral) {
                props.label = stringLiteral.text.replace(/^"/, '').replace(/"$/, '');
            }
        }
        
        // Parse closure for label and destination
        for (const arg of args.children) {
            if (arg.type === 'lambda_literal' || arg.type === 'closure_expression') {
                const statements = findStatementsInClosure(arg);
                for (const stmt of statements) {
                    const child = parseViewExpression(stmt, source);
                    if (child) {
                        // First closure child is typically the destination
                        if (!props.destination) {
                            props.destination = child;
                        } else {
                            children.push(child);
                        }
                    }
                }
            }
        }
    }
    
    return {
        kind: 'NavigationLink',
        props,
        modifiers: [],
        children
    };
}

/**
 * Parse TabView
 */
function parseTabView(node: any, source: string): ViewNode {
    const children: ViewNode[] = [];
    const args = node.children.find((c: any) => c.type === 'call_suffix');
    
    if (args) {
        for (const arg of args.children) {
            if (arg.type === 'lambda_literal' || arg.type === 'closure_expression') {
                const statements = findStatementsInClosure(arg);
                for (const stmt of statements) {
                    const child = parseViewExpression(stmt, source);
                    if (child) {
                        children.push(child);
                    }
                }
            }
        }
    }
    
    return {
        kind: 'TabView',
        props: { selectedTab: 0 },
        modifiers: [],
        children
    };
}

/**
 * Parse AsyncImage
 */
function parseAsyncImage(node: any, source: string): ViewNode {
    const props: Record<string, any> = {
        url: '',
        placeholder: null
    };
    
    const args = node.children.find((c: any) => c.type === 'call_suffix');
    if (args) {
        // Try to extract URL from arguments
        const urlMatch = node.text.match(/url:\s*URL\(string:\s*"([^"]+)"\)/);
        if (urlMatch) {
            props.url = urlMatch[1];
        }
    }
    
    return {
        kind: 'AsyncImage',
        props,
        modifiers: [],
        children: []
    };
}

/**
 * Parse TextEditor
 */
function parseTextEditor(node: any, source: string): ViewNode {
    const props: Record<string, any> = {
        text: 'Text content...'
    };
    
    return {
        kind: 'TextEditor',
        props,
        modifiers: [],
        children: []
    };
}

/**
 * Parse DisclosureGroup
 */
function parseDisclosureGroup(node: any, source: string): ViewNode {
    const props: Record<string, any> = {
        label: 'Disclosure',
        isExpanded: false
    };
    const children: ViewNode[] = [];
    
    const args = node.children.find((c: any) => c.type === 'call_suffix');
    if (args) {
        const valueArgs = args.children.filter((c: any) => c.type === 'value_argument');
        
        // First argument is usually the label
        if (valueArgs.length > 0) {
            const firstArg = valueArgs[0];
            const stringLiteral = firstArg.children.find((c: any) => 
                c.type === 'line_string_literal' || c.type === 'string_literal'
            );
            if (stringLiteral) {
                props.label = stringLiteral.text.replace(/^"/, '').replace(/"$/, '');
            }
        }
        
        // Parse content closure
        for (const arg of args.children) {
            if (arg.type === 'lambda_literal' || arg.type === 'closure_expression') {
                const statements = findStatementsInClosure(arg);
                for (const stmt of statements) {
                    const child = parseViewExpression(stmt, source);
                    if (child) {
                        children.push(child);
                    }
                }
            }
        }
    }
    
    return {
        kind: 'DisclosureGroup',
        props,
        modifiers: [],
        children
    };
}

/**
 * Parse postfix expression (handles modifiers like .padding())
 */
function parsePostfixExpression(node: any, source: string): ViewNode | null {
    // Find the base expression
    const baseExpr = node.children.find((c: any) => 
        c.type === 'call_expression' || 
        c.type === 'postfix_expression' ||
        c.type === 'simple_identifier'
    );
    
    if (!baseExpr) {
        return null;
    }

    // Parse the base expression first
    const viewNode = parseViewExpression(baseExpr, source);
    if (!viewNode) {
        return null;
    }

    // Collect modifiers from postfix expressions
    const modifiers: Modifier[] = [];
    
    for (const child of node.children) {
        if (child.type === 'call_suffix') {
            // This is a modifier like .padding() or .foregroundColor(.red)
            const modifier = parseModifier(child);
            if (modifier) {
                modifiers.push(modifier);
            }
        }
    }

    // Merge modifiers with the view node
    viewNode.modifiers = [...viewNode.modifiers, ...modifiers];
    
    return viewNode;
}

/**
 * Parse a modifier call (e.g., .padding(16), .foregroundColor(.red))
 */
function parseModifier(callSuffix: any): Modifier | null {
    // Find the modifier name from navigation_suffix
    let modifierName: string | null = null;
    
    for (const child of callSuffix.children) {
        if (child.type === 'navigation_suffix') {
            const identifier = child.children.find((c: any) => c.type === 'simple_identifier');
            if (identifier) {
                modifierName = identifier.text;
                break;
            }
        }
    }
    
    if (!modifierName) {
        return null;
    }
    
    // Parse arguments
    const args: Record<string, any> = {};
    
    // Find argument list
    const argList = callSuffix.children.find((c: any) => 
        c.type === 'value_arguments' || 
        c.type === 'argument_list' ||
        c.type === 'tuple_expression'
    );
    
    if (argList) {
        const argNodes = argList.children.filter((c: any) => 
            c.type === 'value_argument' || 
            c.type === 'simple_identifier' ||
            c.type === 'integer_literal' ||
            c.type === 'navigation_expression' ||
            c.type === 'call_expression'
        );
        
        for (const arg of argNodes) {
            parseModifierArgument(arg, args, modifierName);
        }
    }
    
    return {
        name: modifierName,
        args
    };
}

/**
 * Parse a single modifier argument and add to args object
 */
function parseModifierArgument(node: any, args: Record<string, any>, modifierName: string) {
    // Handle labeled arguments like width: 200
    if (node.type === 'value_argument') {
        const label = node.children.find((c: any) => c.type === 'value_argument_label');
        const value = node.children.find((c: any) => 
            c.type === 'integer_literal' || 
            c.type === 'float_literal' ||
            c.type === 'navigation_expression' ||
            c.type === 'call_expression'
        );
        
        if (label && value) {
            const labelText = label.text.replace(':', '');
            if (value.type === 'integer_literal' || value.type === 'float_literal') {
                args[labelText] = parseFloat(value.text);
            } else if (value.type === 'navigation_expression' || value.type === 'call_expression') {
                // Extract color/enum value
                const colorName = extractEnumValue(value);
                if (colorName) {
                    args[labelText] = colorName;
                }
            }
        }
    }
    // Handle unlabeled arguments
    else if (node.type === 'integer_literal' || node.type === 'float_literal') {
        // Unlabeled numeric argument (e.g., padding(16), cornerRadius(12), opacity(0.5))
        const value = parseFloat(node.text);
        if (modifierName === 'padding') {
            args.all = value;
        } else if (modifierName === 'cornerRadius') {
            args.radius = value;
        } else if (modifierName === 'shadow') {
            args.radius = value;
        } else if (modifierName === 'opacity') {
            args.value = value;
        } else if (modifierName === 'lineLimit') {
            args.lines = Math.floor(value);
        }
    }
    // Handle enum-style arguments like .red, .title, .center, .ultraThinMaterial
    else if (node.type === 'navigation_expression') {
        const enumValue = extractEnumValue(node);
        if (enumValue) {
            if (modifierName === 'foregroundColor') {
                args.color = enumValue;
            } else if (modifierName === 'font') {
                args.style = enumValue;
            } else if (modifierName === 'multilineTextAlignment') {
                args.alignment = enumValue;
            } else if (modifierName === 'background') {
                // Check if it's a material
                if (enumValue.includes('Material') || enumValue === 'ultraThin' || enumValue === 'thin' || enumValue === 'regular') {
                    const materialKind = enumValue.replace('Material', '');
                    args.material = materialKind.charAt(0).toLowerCase() + materialKind.slice(1) || enumValue;
                } else {
                    args.color = enumValue;
                }
            }
        }
    }
    // Handle Color.blue style and overlay content
    else if (node.type === 'call_expression') {
        const typeName = node.children.find((c: any) => c.type === 'simple_identifier' || c.type === 'navigation_expression');
        if (typeName && typeName.text === 'Color') {
            // Look for Color.xxx pattern
            const colorExpr = node.children.find((c: any) => c.type === 'navigation_expression');
            if (colorExpr) {
                const colorName = extractEnumValue(colorExpr);
                if (colorName && modifierName === 'background') {
                    args.color = colorName;
                }
            }
        } else if (modifierName === 'overlay') {
            // Parse overlay content as a ViewNode
            const overlayNode = parseViewExpression(node, '');
            if (overlayNode) {
                args.content = overlayNode;
            }
        } else if (modifierName === 'animation') {
            // Mark that this view has animation
            args.hasAnimation = true;
        } else if (modifierName === 'rotationEffect') {
            // Parse rotation angle
            const angleMatch = node.text.match(/\.degrees\(([-\d.]+)\)|Angle\(degrees:\s*([-\d.]+)\)/);
            const radianMatch = node.text.match(/\.radians\(([-\d.]+)\)/);
            if (angleMatch) {
                args.degrees = parseFloat(angleMatch[1] || angleMatch[2]);
            } else if (radianMatch) {
                args.radians = parseFloat(radianMatch[1]);
            }
        } else if (modifierName === 'scaleEffect') {
            // Parse scale value
            const scaleMatch = node.text.match(/scaleEffect\(([-\d.]+)\)/);
            if (scaleMatch) {
                args.scale = parseFloat(scaleMatch[1]);
            }
        } else if (modifierName === 'offset') {
            // Parse x and y offset
            const xMatch = node.text.match(/x:\s*([-\d.]+)/);
            const yMatch = node.text.match(/y:\s*([-\d.]+)/);
            if (xMatch) args.x = parseFloat(xMatch[1]);
            if (yMatch) args.y = parseFloat(yMatch[1]);
        } else if (modifierName === 'border') {
            // Parse border color and width
            const colorName = extractEnumValue(node);
            if (colorName) {
                args.color = colorName;
            }
        } else if (modifierName === 'fill' || modifierName === 'stroke') {
            // Parse fill/stroke color
            const colorName = extractEnumValue(node);
            if (colorName) {
                args.color = colorName;
            }
        } else if (modifierName === 'onTapGesture') {
            // Mark that this view has tap gesture
            args.hasTapGesture = true;
        } else if (modifierName === 'position') {
            // Parse x and y position
            const xMatch = node.text.match(/x:\s*([-\d.]+)/);
            const yMatch = node.text.match(/y:\s*([-\d.]+)/);
            if (xMatch) args.x = parseFloat(xMatch[1]);
            if (yMatch) args.y = parseFloat(yMatch[1]);
        } else if (modifierName === 'aspectRatio') {
            // Parse aspect ratio
            const ratioMatch = node.text.match(/([\d.]+)/);
            if (ratioMatch) args.ratio = parseFloat(ratioMatch[1]);
            if (node.text.includes('fit')) args.contentMode = 'fit';
            if (node.text.includes('fill')) args.contentMode = 'fill';
        } else if (modifierName === 'scaledToFit') {
            args.contentMode = 'fit';
        } else if (modifierName === 'scaledToFill') {
            args.contentMode = 'fill';
        } else if (modifierName === 'foregroundStyle' || modifierName === 'tint') {
            const colorName = extractEnumValue(node);
            if (colorName) args.color = colorName;
        } else if (modifierName === 'clipShape' || modifierName === 'mask') {
            // Store shape type
            if (node.text.includes('Circle')) args.shape = 'circle';
            else if (node.text.includes('Rectangle')) args.shape = 'rectangle';
            else if (node.text.includes('RoundedRectangle')) args.shape = 'roundedRectangle';
            else if (node.text.includes('Capsule')) args.shape = 'capsule';
        } else if (modifierName === 'brightness') {
            const valueMatch = node.text.match(/([-\d.]+)/);
            if (valueMatch) args.amount = parseFloat(valueMatch[1]);
        } else if (modifierName === 'contrast') {
            const valueMatch = node.text.match(/([-\d.]+)/);
            if (valueMatch) args.amount = parseFloat(valueMatch[1]);
        } else if (modifierName === 'saturation') {
            const valueMatch = node.text.match(/([-\d.]+)/);
            if (valueMatch) args.amount = parseFloat(valueMatch[1]);
        } else if (modifierName === 'hueRotation') {
            const angleMatch = node.text.match(/\.degrees\(([-\d.]+)\)/);
            if (angleMatch) args.degrees = parseFloat(angleMatch[1]);
        } else if (modifierName === 'onLongPressGesture') {
            args.hasLongPress = true;
        } else if (modifierName === 'disabled') {
            const boolMatch = node.text.match(/(true|false)/);
            if (boolMatch) args.isDisabled = boolMatch[1] === 'true';
            else args.isDisabled = true;
        } else if (modifierName === 'onAppear' || modifierName === 'onDisappear') {
            args.hasLifecycle = true;
        } else if (modifierName === 'fontWeight') {
            const weightMatch = node.text.match(/\.(\w+)/);
            if (weightMatch) args.weight = weightMatch[1];
        } else if (modifierName === 'kerning' || modifierName === 'tracking') {
            const valueMatch = node.text.match(/([-\d.]+)/);
            if (valueMatch) args.amount = parseFloat(valueMatch[1]);
        } else if (modifierName === 'baselineOffset') {
            const valueMatch = node.text.match(/([-\d.]+)/);
            if (valueMatch) args.offset = parseFloat(valueMatch[1]);
        } else if (modifierName === 'transition') {
            if (node.text.includes('slide')) args.type = 'slide';
            else if (node.text.includes('scale')) args.type = 'scale';
            else if (node.text.includes('opacity')) args.type = 'opacity';
            else if (node.text.includes('move')) args.type = 'move';
        } else if (modifierName === 'accessibilityLabel' || modifierName === 'accessibilityHint' || modifierName === 'accessibilityValue') {
            const stringMatch = node.text.match(/"([^"]+)"/);
            if (stringMatch) args.text = stringMatch[1];
        } else if (modifierName === 'navigationTitle') {
            const stringMatch = node.text.match(/"([^"]+)"/);
            if (stringMatch) args.title = stringMatch[1];
        } else if (modifierName === 'navigationBarTitleDisplayMode') {
            const modeMatch = node.text.match(/\.(\w+)/);
            if (modeMatch) args.displayMode = modeMatch[1];
        } else if (modifierName === 'toolbar') {
            args.hasToolbar = true;
        } else if (modifierName === 'toolbarBackground') {
            const colorName = extractEnumValue(node);
            if (colorName) args.color = colorName;
        } else if (modifierName === 'navigationBarBackButtonHidden') {
            const boolMatch = node.text.match(/(true|false)/);
            if (boolMatch) args.hidden = boolMatch[1] === 'true';
            else args.hidden = true;
        } else if (modifierName === 'tabItem') {
            args.hasTabItem = true;
        } else if (modifierName === 'badge') {
            const valueMatch = node.text.match(/(\d+)|"([^"]+)"/);
            if (valueMatch) {
                args.badgeValue = valueMatch[1] || valueMatch[2];
            }
        } else if (modifierName === 'id') {
            const stringMatch = node.text.match(/"([^"]+)"/);
            const numberMatch = node.text.match(/(\d+)/);
            if (stringMatch) args.id = stringMatch[1];
            else if (numberMatch) args.id = numberMatch[1];
        } else if (modifierName === 'searchable') {
            args.isSearchable = true;
        } else if (modifierName === 'refreshable') {
            args.isRefreshable = true;
        } else if (modifierName === 'swipeActions') {
            args.hasSwipeActions = true;
        } else if (modifierName === 'contextMenu') {
            args.hasContextMenu = true;
        } else if (modifierName === 'sheet' || modifierName === 'fullScreenCover') {
            args.isPresented = true;
        } else if (modifierName === 'alert') {
            args.isPresented = true;
            const titleMatch = node.text.match(/title:\s*"([^"]+)"/);
            if (titleMatch) args.title = titleMatch[1];
        } else {
            // Try to extract from the whole expression
            const colorName = extractEnumValue(node);
            if (colorName && modifierName === 'background') {
                args.color = colorName;
            }
        }
    }
}

/**
 * Extract enum value from expressions like .red, .title, Color.blue
 */
function extractEnumValue(node: any): string | null {
    const text = node.text;
    
    // Handle .red, .title patterns
    if (text.startsWith('.')) {
        return text.substring(1);
    }
    
    // Handle Color.red patterns
    const match = text.match(/Color\.(\w+)/);
    if (match) {
        return match[1];
    }
    
    // Try to find the last identifier in navigation
    const identifiers = node.children.filter((c: any) => c.type === 'simple_identifier');
    if (identifiers.length > 0) {
        return identifiers[identifiers.length - 1].text;
    }
    
    return null;
}

/**
 * Extract modifier name from call suffix (legacy helper)
 */
function extractModifierName(node: any): string | null {
    // Look for navigation_suffix or simple identifier
    for (const child of node.children) {
        if (child.type === 'navigation_suffix') {
            const identifier = child.children.find((c: any) => c.type === 'simple_identifier');
            if (identifier) {
                return identifier.text;
            }
        }
    }
    
    // Sometimes it's directly a function call
    const text = node.text;
    const match = text.match(/\.(\w+)/);
    if (match) {
        return match[1];
    }
    
    return null;
}

/**
 * Find statements in a closure
 */
function findStatementsInClosure(closure: any): any[] {
    const statements: any[] = [];
    
    for (const child of closure.children) {
        if (child.type === 'statements') {
            // Get all statement children
            for (const stmt of child.children) {
                if (stmt.type !== '{' && stmt.type !== '}' && stmt.text.trim()) {
                    statements.push(stmt);
                }
            }
        }
    }
    
    return statements;
}

/**
 * Simple regex-based fallback parser when tree-sitter is not available
 * This provides basic parsing support but won't handle complex Swift syntax
 */
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
        
        const bodyContent = source.substring(openBraceIndex + 1, closeBraceIndex - 1).trim();
        
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
        } else if (remaining.match(/^Image\("/)) {
            const imgMatch = remaining.match(/^Image\("([^"]+)"\)/);
            if (imgMatch) {
                children.push({ kind: 'Image', props: { name: imgMatch[1] }, modifiers: [], children: [] });
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
