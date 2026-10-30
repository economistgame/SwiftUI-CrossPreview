import { ViewNode, Modifier } from '../parser/viewTree';

/**
 * Renders a ViewNode tree to HTML
 */
export function renderToHtml(root: ViewNode): string {
    return `<div class="root">${renderNode(root)}</div>`;
}

/**
 * Renders an error banner for parse failures
 */
export function renderErrorBanner(errors: string[]): string {
    const errorItems = errors.map(err => `<li>${escapeHtml(err)}</li>`).join('');
    return `<div class="error-banner">
        <strong>Failed to parse SwiftUI body:</strong>
        <ul>${errorItems}</ul>
    </div>`;
}

/**
 * Build inline CSS style from modifiers
 */
function buildStyle(node: ViewNode): string {
    if (!node.modifiers || node.modifiers.length === 0) {
        return '';
    }
    
    const styles: string[] = [];
    let hasOverlay = false;
    
    for (const modifier of node.modifiers) {
        switch (modifier.name) {
            case 'padding':
                if (modifier.args.all !== undefined) {
                    styles.push(`padding: ${modifier.args.all}px`);
                } else {
                    styles.push('padding: 8px');
                }
                break;
                
            case 'foregroundColor':
                if (modifier.args.color) {
                    const cssColor = swiftColorToCss(modifier.args.color);
                    styles.push(`color: ${cssColor}`);
                }
                break;
                
            case 'background':
                if (modifier.args.color) {
                    const cssColor = swiftColorToCss(modifier.args.color);
                    styles.push(`background-color: ${cssColor}`);
                }
                break;
                
            case 'backgroundMaterial':
            case 'material':
                if (modifier.args.material || modifier.args.kind) {
                    const materialKind = modifier.args.material || modifier.args.kind;
                    const materialStyles = getMaterialStyles(materialKind);
                    styles.push(...materialStyles);
                }
                break;
                
            case 'font':
                if (modifier.args.style) {
                    const { fontSize, fontWeight } = swiftFontStyleToCss(modifier.args.style);
                    styles.push(`font-size: ${fontSize}`);
                    styles.push(`font-weight: ${fontWeight}`);
                }
                break;
                
            case 'frame':
                if (modifier.args.width !== undefined) {
                    styles.push(`width: ${modifier.args.width}px`);
                }
                if (modifier.args.height !== undefined) {
                    styles.push(`height: ${modifier.args.height}px`);
                }
                if (modifier.args.maxWidth === 'infinity') {
                    styles.push('width: 100%');
                }
                break;
                
            case 'cornerRadius':
                if (modifier.args.radius !== undefined) {
                    styles.push(`border-radius: ${modifier.args.radius}px`);
                }
                break;
                
            case 'shadow':
                const radius = modifier.args.radius !== undefined ? modifier.args.radius : 8;
                styles.push(`box-shadow: 0 ${radius / 2}px ${radius * 2}px rgba(0,0,0,0.35)`);
                break;
                
            case 'opacity':
                if (modifier.args.value !== undefined) {
                    styles.push(`opacity: ${modifier.args.value}`);
                }
                break;
                
            case 'blur':
                if (modifier.args.radius !== undefined) {
                    styles.push(`filter: blur(${modifier.args.radius}px)`);
                }
                break;
                
            case 'multilineTextAlignment':
                if (modifier.args.alignment) {
                    const alignment = modifier.args.alignment;
                    if (alignment === 'leading') styles.push('text-align: left');
                    else if (alignment === 'center') styles.push('text-align: center');
                    else if (alignment === 'trailing') styles.push('text-align: right');
                }
                break;
                
            case 'lineLimit':
                if (modifier.args.lines !== undefined) {
                    styles.push('display: -webkit-box');
                    styles.push(`-webkit-line-clamp: ${modifier.args.lines}`);
                    styles.push('-webkit-box-orient: vertical');
                    styles.push('overflow: hidden');
                }
                break;
                
            case 'animation':
                // Add visual indicator for animated properties
                styles.push('position: relative');
                break;
                
            case 'rotationEffect':
                if (modifier.args.degrees !== undefined) {
                    styles.push(`transform: rotate(${modifier.args.degrees}deg)`);
                } else if (modifier.args.radians !== undefined) {
                    const degrees = modifier.args.radians * (180 / Math.PI);
                    styles.push(`transform: rotate(${degrees}deg)`);
                }
                break;
                
            case 'scaleEffect':
                const scale = modifier.args.scale !== undefined ? modifier.args.scale : 1;
                styles.push(`transform: scale(${scale})`);
                break;
                
            case 'offset':
                if (modifier.args.x !== undefined || modifier.args.y !== undefined) {
                    const x = modifier.args.x || 0;
                    const y = modifier.args.y || 0;
                    styles.push(`transform: translate(${x}px, ${y}px)`);
                }
                break;
                
            case 'border':
                const borderWidth = modifier.args.width || 1;
                const borderColor = modifier.args.color ? swiftColorToCss(modifier.args.color) : '#000000';
                styles.push(`border: ${borderWidth}px solid ${borderColor}`);
                break;
                
            case 'fill':
                if (modifier.args.material) {
                    const materialStyles = getMaterialStyles(modifier.args.material);
                    styles.push(...materialStyles);
                } else if (modifier.args.gradient === 'linear' && modifier.args.colors) {
                    // Handle LinearGradient fill
                    const gradientColors = modifier.args.colors.map((c: string) => swiftColorToCss(c)).join(', ');
                    styles.push(`background: linear-gradient(135deg, ${gradientColors})`);
                } else if (modifier.args.color) {
                    const fillColor = swiftColorToCss(modifier.args.color);
                    styles.push(`background-color: ${fillColor}`);
                }
                break;
                
            case 'stroke':
                if (modifier.args.color) {
                    const strokeColor = swiftColorToCss(modifier.args.color);
                    const strokeWidth = modifier.args.lineWidth || 1;
                    styles.push(`border: ${strokeWidth}px solid ${strokeColor}`);
                    styles.push('background-color: transparent');
                }
                break;
                
            case 'bold':
                styles.push('font-weight: bold');
                break;
                
            case 'italic':
                styles.push('font-style: italic');
                break;
                
            case 'underline':
                styles.push('text-decoration: underline');
                break;
                
            case 'strikethrough':
                styles.push('text-decoration: line-through');
                break;
                
            case 'clipped':
                styles.push('overflow: hidden');
                break;
                
            case 'onTapGesture':
                styles.push('cursor: pointer');
                styles.push('user-select: none');
                break;
                
            case 'onLongPressGesture':
                styles.push('cursor: pointer');
                styles.push('user-select: none');
                break;
                
            case 'disabled':
                if (modifier.args.isDisabled) {
                    styles.push('opacity: 0.5');
                    styles.push('pointer-events: none');
                }
                break;
                
            case 'position':
                if (modifier.args.x !== undefined && modifier.args.y !== undefined) {
                    styles.push('position: absolute');
                    styles.push(`left: ${modifier.args.x}px`);
                    styles.push(`top: ${modifier.args.y}px`);
                    styles.push('transform: translate(-50%, -50%)');
                }
                break;
                
            case 'aspectRatio':
                if (modifier.args.ratio) {
                    styles.push(`aspect-ratio: ${modifier.args.ratio}`);
                }
                if (modifier.args.contentMode === 'fit') {
                    styles.push('object-fit: contain');
                } else if (modifier.args.contentMode === 'fill') {
                    styles.push('object-fit: cover');
                }
                break;
                
            case 'scaledToFit':
                styles.push('object-fit: contain');
                break;
                
            case 'scaledToFill':
                styles.push('object-fit: cover');
                break;
                
            case 'foregroundStyle':
            case 'tint':
                if (modifier.args.color) {
                    const cssColor = swiftColorToCss(modifier.args.color);
                    styles.push(`color: ${cssColor}`);
                }
                break;
                
            case 'clipShape':
                if (modifier.args.shape === 'circle') {
                    styles.push('border-radius: 50%');
                    styles.push('overflow: hidden');
                } else if (modifier.args.shape === 'capsule') {
                    styles.push('border-radius: 9999px');
                    styles.push('overflow: hidden');
                } else if (modifier.args.shape === 'roundedRectangle') {
                    const radius = modifier.args.cornerRadius || 10;
                    styles.push(`border-radius: ${radius}px`);
                    styles.push('overflow: hidden');
                } else {
                    styles.push('overflow: hidden');
                }
                break;
                
            case 'mask':
                styles.push('overflow: hidden');
                break;
                
            case 'brightness':
                if (modifier.args.amount !== undefined) {
                    const brightness = 1 + modifier.args.amount;
                    styles.push(`filter: brightness(${brightness})`);
                }
                break;
                
            case 'contrast':
                if (modifier.args.amount !== undefined) {
                    const contrast = 1 + modifier.args.amount;
                    styles.push(`filter: contrast(${contrast})`);
                }
                break;
                
            case 'saturation':
                if (modifier.args.amount !== undefined) {
                    const saturation = modifier.args.amount;
                    styles.push(`filter: saturate(${saturation})`);
                }
                break;
                
            case 'hueRotation':
                if (modifier.args.degrees !== undefined) {
                    styles.push(`filter: hue-rotate(${modifier.args.degrees}deg)`);
                }
                break;
                
            case 'onLongPressGesture':
                styles.push('cursor: pointer');
                styles.push('user-select: none');
                break;
                
            case 'disabled':
                if (modifier.args.isDisabled !== false) {
                    styles.push('opacity: 0.5');
                    styles.push('pointer-events: none');
                }
                break;
                
            case 'fontWeight':
                const weightMap: Record<string, string> = {
                    'ultraLight': '100', 'thin': '200', 'light': '300',
                    'regular': '400', 'medium': '500', 'semibold': '600',
                    'bold': '700', 'heavy': '800', 'black': '900'
                };
                const weight = weightMap[modifier.args.weight] || '400';
                styles.push(`font-weight: ${weight}`);
                break;
                
            case 'kerning':
            case 'tracking':
                if (modifier.args.amount !== undefined) {
                    styles.push(`letter-spacing: ${modifier.args.amount}px`);
                }
                break;
                
            case 'baselineOffset':
                if (modifier.args.offset !== undefined) {
                    styles.push(`vertical-align: ${modifier.args.offset}px`);
                }
                break;
                
            case 'transition':
                // Transitions are visual hints only in preview
                if (modifier.args.type) {
                    styles.push(`transition: all 0.3s ease`);
                }
                break;
                
            case 'overlay':
                hasOverlay = true;
                break;
        }
    }
    
    return styles.length > 0 ? ` style="${styles.join('; ')}"` : '';
}

/**
 * Get CSS styles for glass/material backgrounds
 */
function getMaterialStyles(kind: string): string[] {
    const styles: string[] = [];
    const normalizedKind = kind.toLowerCase().replace('material', '');
    
    switch (normalizedKind) {
        case 'ultrathin':
            styles.push('background-color: rgba(200,200,200,0.3)');
            styles.push('backdrop-filter: blur(20px)');
            styles.push('-webkit-backdrop-filter: blur(20px)');
            break;
        case 'thin':
            styles.push('background-color: rgba(200,200,200,0.4)');
            styles.push('backdrop-filter: blur(20px)');
            styles.push('-webkit-backdrop-filter: blur(20px)');
            break;
        case 'regular':
            styles.push('background-color: rgba(200,200,200,0.5)');
            styles.push('backdrop-filter: blur(20px)');
            styles.push('-webkit-backdrop-filter: blur(20px)');
            break;
        case 'thick':
            styles.push('background-color: rgba(200,200,200,0.6)');
            styles.push('backdrop-filter: blur(20px)');
            styles.push('-webkit-backdrop-filter: blur(20px)');
            break;
        case 'ultrathick':
            styles.push('background-color: rgba(200,200,200,0.7)');
            styles.push('backdrop-filter: blur(20px)');
            styles.push('-webkit-backdrop-filter: blur(20px)');
            break;
        default:
            // Also handle full names like "ultraThinMaterial"
            if (normalizedKind.includes('ultrathin')) {
                styles.push('background-color: rgba(200,200,200,0.3)');
            } else if (normalizedKind.includes('thin')) {
                styles.push('background-color: rgba(200,200,200,0.4)');
            } else {
                styles.push('background-color: rgba(200,200,200,0.5)');
            }
            styles.push('backdrop-filter: blur(20px)');
            styles.push('-webkit-backdrop-filter: blur(20px)');
    }
    
    return styles;
}

/**
 * Map Swift color names to CSS colors
 */
function swiftColorToCss(swiftColor: string): string {
    const colorMap: Record<string, string> = {
        'red': '#ff3b30',
        'orange': '#ff9500',
        'yellow': '#ffcc00',
        'green': '#34c759',
        'mint': '#00c7be',
        'teal': '#30b0c7',
        'cyan': '#32ade6',
        'blue': '#007aff',
        'indigo': '#5856d6',
        'purple': '#af52de',
        'pink': '#ff2d55',
        'brown': '#a2845e',
        'white': '#ffffff',
        'gray': '#8e8e93',
        'black': '#000000',
        'clear': 'transparent'
    };
    
    return colorMap[swiftColor.toLowerCase()] || swiftColor;
}

/**
 * Map Swift font styles to CSS font properties
 */
function swiftFontStyleToCss(style: string): { fontSize: string; fontWeight: string } {
    const fontMap: Record<string, { fontSize: string; fontWeight: string }> = {
        'largeTitle': { fontSize: '28px', fontWeight: 'bold' },
        'title': { fontSize: '22px', fontWeight: 'bold' },
        'title2': { fontSize: '20px', fontWeight: 'bold' },
        'title3': { fontSize: '18px', fontWeight: 'semibold' },
        'headline': { fontSize: '14px', fontWeight: 'semibold' },
        'body': { fontSize: '14px', fontWeight: 'normal' },
        'callout': { fontSize: '13px', fontWeight: 'normal' },
        'subheadline': { fontSize: '12px', fontWeight: 'normal' },
        'footnote': { fontSize: '11px', fontWeight: 'normal' },
        'caption': { fontSize: '10px', fontWeight: 'normal' },
        'caption2': { fontSize: '10px', fontWeight: 'normal' }
    };
    
    return fontMap[style] || { fontSize: '14px', fontWeight: 'normal' };
}

function renderNode(node: ViewNode): string {
    // Check if node has overlay modifier
    const overlayModifier = node.modifiers?.find(m => m.name === 'overlay');
    
    // Build base element
    let baseHtml = '';
    const style = buildStyle(node);
    
    // Handle stack alignment and spacing in class/style
    let stackClasses = '';
    let stackStyles = '';
    
    switch (node.kind) {
        case 'VStack':
            stackClasses = 'vstack';
            if (node.props.spacing !== undefined) {
                stackStyles += `gap: ${node.props.spacing}px; `;
            }
            if (node.props.alignment) {
                const align = node.props.alignment;
                if (align === 'leading') stackStyles += 'align-items: flex-start; ';
                else if (align === 'center') stackStyles += 'align-items: center; ';
                else if (align === 'trailing') stackStyles += 'align-items: flex-end; ';
            }
            baseHtml = `<div class="${stackClasses}"${stackStyles ? ` style="${stackStyles.trim()}"` : ''}${style}>${node.children.map(renderNode).join('')}</div>`;
            break;
            
        case 'HStack':
            stackClasses = 'hstack';
            if (node.props.spacing !== undefined) {
                stackStyles += `gap: ${node.props.spacing}px; `;
            }
            if (node.props.alignment) {
                const align = node.props.alignment;
                if (align === 'top') stackStyles += 'align-items: flex-start; ';
                else if (align === 'center') stackStyles += 'align-items: center; ';
                else if (align === 'bottom') stackStyles += 'align-items: flex-end; ';
            }
            baseHtml = `<div class="${stackClasses}"${stackStyles ? ` style="${stackStyles.trim()}"` : ''}${style}>${node.children.map(renderNode).join('')}</div>`;
            break;
            
        case 'ZStack':
            baseHtml = `<div class="zstack"${style}>${node.children.map(renderNode).join('')}</div>`;
            break;
            
        case 'Text':
            baseHtml = `<div class="text"${style}>${escapeHtml(node.props.text ?? '')}</div>`;
            break;
            
        case 'Image':
            baseHtml = node.props.systemName
                ? `<span class="sf-symbol" title="${escapeHtml(node.props.name ?? '')}"${style}>◆</span>`
                : `<div class="image-placeholder"${style}>${escapeHtml(node.props.name ?? 'Image')}</div>`;
            break;
            
        case 'Spacer':
            baseHtml = `<div class="spacer"${style}></div>`;
            break;
            
        case 'List':
            baseHtml = `<div class="list"${style}>${node.children.map(renderNode).join('')}</div>`;
            break;
            
        case 'Form':
            baseHtml = `<div class="form"${style}>${node.children.map(renderNode).join('')}</div>`;
            break;
            
        case 'Section':
            const headerHtml = node.props.header ? `<div class="section-header">${escapeHtml(node.props.header)}</div>` : '';
            baseHtml = `<div class="section"${style}>${headerHtml}<div class="section-body">${node.children.map(renderNode).join('')}</div></div>`;
            break;
            
        case 'ScrollView':
            baseHtml = `<div class="scrollview"${style}>${node.children.map(renderNode).join('')}</div>`;
            break;
            
        case 'ForEach':
            baseHtml = renderForEach(node);
            break;
            
        case 'Button':
            const buttonLabel = node.children.map(renderNode).join('') || 'Button';
            const destructive = node.props.role === 'destructive' ? ' destructive' : '';
            if (node.props.style === 'plain') {
                baseHtml = `<div class="button-plain"${style}>${buttonLabel}</div>`;
            } else if (node.props.style === 'row') {
                baseHtml = `<div class="button-row${destructive}"${style}>${buttonLabel}</div>`;
            } else {
                baseHtml = `<button class="button${destructive}"${style}>${buttonLabel}</button>`;
            }
            break;
            
        case 'Toggle':
            const toggleLabel = node.props.label || 'Toggle';
            const toggleState = node.props.isOn ? 'checked' : '';
            baseHtml = `<label class="toggle"${style}><span>${escapeHtml(toggleLabel)}</span><input type="checkbox" ${toggleState}><span class="toggle-switch"></span></label>`;
            break;
            
        case 'Picker':
            const pickerLabel = node.props.label || 'Picker';
            const pickerOptions = node.children.map(child => {
                if (child.kind === 'Text') {
                    return `<option>${escapeHtml(child.props.text || '')}</option>`;
                }
                return '';
            }).join('');
            baseHtml = `<div class="picker"${style}><label>${escapeHtml(pickerLabel)}</label><select>${pickerOptions || '<option>Option</option>'}</select></div>`;
            break;
            
        case 'LinearGradient':
            const linearColors = node.props.colors || ['blue', 'purple'];
            const startPoint = mapGradientPoint(node.props.startPoint || 'top');
            const endPoint = mapGradientPoint(node.props.endPoint || 'bottom');
            const linearGradient = `linear-gradient(${calculateGradientAngle(startPoint, endPoint)}deg, ${linearColors.map((c: string) => swiftColorToCss(c)).join(', ')})`;
            baseHtml = `<div class="gradient"${style} style="background: ${linearGradient};"></div>`;
            break;
            
        case 'RadialGradient':
            const radialColors = node.props.colors || ['blue', 'purple'];
            const radialGradient = `radial-gradient(circle, ${radialColors.map((c: string) => swiftColorToCss(c)).join(', ')})`;
            baseHtml = `<div class="gradient"${style} style="background: ${radialGradient};"></div>`;
            break;
            
        case 'TextField':
            const placeholder = node.props.placeholder || 'Enter text';
            baseHtml = `<input type="text" class="textfield" placeholder="${escapeHtml(placeholder)}"${style}>`;
            break;
            
        case 'SecureField':
            const secureplaceholder = node.props.placeholder || 'Enter password';
            baseHtml = `<input type="password" class="textfield securefield" placeholder="${escapeHtml(secureplaceholder)}"${style}>`;
            break;
            
        case 'Rectangle':
            baseHtml = `<div class="shape rectangle"${style}></div>`;
            break;
            
        case 'Circle':
            baseHtml = `<div class="shape circle"${style}></div>`;
            break;
            
        case 'RoundedRectangle':
            const cornerRadius = node.props.cornerRadius || 8;
            const rectStyle = style ? style.replace('"', ` border-radius: ${cornerRadius}px;"`) : ` style="border-radius: ${cornerRadius}px;"`;
            baseHtml = `<div class="shape rounded-rectangle"${rectStyle}></div>`;
            break;
            
        case 'Capsule':
            baseHtml = `<div class="shape capsule"${style}></div>`;
            break;
            
        case 'Ellipse':
            baseHtml = `<div class="shape ellipse"${style}></div>`;
            break;
            
        case 'Divider':
            baseHtml = `<div class="divider"${style}></div>`;
            break;
            
        case 'Label':
            const labelTitle = node.props.title || '';
            const labelIcon = node.props.systemImage || '';
            const iconHtml = labelIcon ? `<span class="label-icon">○</span>` : '';
            baseHtml = `<div class="label"${style}>${iconHtml}<span class="label-text">${escapeHtml(labelTitle)}</span></div>`;
            break;
            
        case 'Slider':
            const sliderValue = node.props.value || 0.5;
            const sliderMin = node.props.range?.[0] ?? 0;
            const sliderMax = node.props.range?.[1] ?? 1;
            const sliderStep = (sliderMax - sliderMin) > 10 ? 1 : 0.1;
            const sliderPercent = ((sliderValue - sliderMin) / (sliderMax - sliderMin)) * 100;
            const sliderStyle = `style="--slider-percent: ${sliderPercent}%"`;
            baseHtml = `<div class="slider-container"${style}><input type="range" class="slider" ${sliderStyle} min="${sliderMin}" max="${sliderMax}" step="${sliderStep}" value="${sliderValue}"><div class="slider-value">${sliderValue}</div></div>`;
            break;
            
        case 'Stepper':
            const stepperLabel = node.props.label || 'Stepper';
            const stepperValue = node.props.value || 0;
            baseHtml = `<div class="stepper"${style}><span>${escapeHtml(stepperLabel)}</span><div class="stepper-controls"><button>-</button><span>${stepperValue}</span><button>+</button></div></div>`;
            break;
            
        case 'DatePicker':
            const dateLabel = node.props.label || 'Date';
            baseHtml = `<div class="datepicker"${style}><label>${escapeHtml(dateLabel)}</label><input type="date"></div>`;
            break;
            
        case 'ColorPicker':
            const colorLabel = node.props.label || 'Color';
            baseHtml = `<div class="colorpicker"${style}><label>${escapeHtml(colorLabel)}</label><input type="color" value="#007aff"></div>`;
            break;
            
        case 'ProgressView':
            if (node.props.value !== null && node.props.value !== undefined) {
                const progressValue = Math.max(0, Math.min(1, node.props.value));
                baseHtml = `<div class="progressview"${style}><div class="progress-bar" style="width: ${progressValue * 100}%"></div></div>`;
            } else {
                baseHtml = `<div class="progressview indeterminate"${style}><div class="progress-spinner"></div></div>`;
            }
            break;
            
        case 'Link':
            const linkTitle = node.props.title || 'Link';
            const linkDest = node.props.destination || '#';
            baseHtml = `<a href="${escapeHtml(linkDest)}" class="link"${style}>${escapeHtml(linkTitle)}</a>`;
            break;
            
        case 'Menu':
            const menuLabel = node.props.label || 'Menu';
            const menuItems = node.children.map(renderNode).join('');
            baseHtml = `<div class="menu"${style}><button class="menu-button">${escapeHtml(menuLabel)} ▾</button><div class="menu-content">${menuItems}</div></div>`;
            break;
            
        case 'LazyVStack':
            baseHtml = `<div class="vstack lazy-vstack"${style}>${node.children.map(renderNode).join('')}</div>`;
            break;
            
        case 'LazyHStack':
            baseHtml = `<div class="hstack lazy-hstack"${style}>${node.children.map(renderNode).join('')}</div>`;
            break;
            
        case 'Grid':
            baseHtml = `<div class="grid"${style}>${node.children.map(renderNode).join('')}</div>`;
            break;
            
        case 'Group':
            baseHtml = `<div class="group"${style}>${node.children.map(renderNode).join('')}</div>`;
            break;
            
        case 'GeometryReader':
            baseHtml = `<div class="geometry-reader"${style}>${node.children.map(renderNode).join('')}</div>`;
            break;
            
        case 'NavigationView':
        case 'NavigationStack':
            const navTitle = node.props.title || '';
            const navContent = node.children.map(renderNode).join('');
            baseHtml = `<div class="navigation-view"${style}>
                ${navTitle ? `<div class="navigation-bar"><div class="nav-title">${escapeHtml(navTitle)}</div></div>` : ''}
                <div class="navigation-content">${navContent}</div>
            </div>`;
            break;
            
        case 'NavigationLink':
            const linkLabel = node.props.label || 'Link';
            const navLinkDest = node.props.destination || '';
            baseHtml = `<div class="navigation-link"${style}>
                <div class="nav-link-label">${escapeHtml(linkLabel)}</div>
                <div class="nav-link-chevron">›</div>
            </div>`;
            break;
            
        case 'NavigationSplitView':
            const sidebarContent = node.props.sidebar ? renderNode(node.props.sidebar) : '';
            const detailContent = node.props.detail ? renderNode(node.props.detail) : '';
            baseHtml = `<div class="navigation-split-view"${style}>
                <div class="nav-sidebar">${sidebarContent}</div>
                <div class="nav-detail">${detailContent}</div>
            </div>`;
            break;
            
        case 'TabView':
            const tabs = node.children.map((child, idx) => {
                const tabLabel = child.props.tabLabel || `Tab ${idx + 1}`;
                const badgeValue = child.props.badgeValue || '';
                return `<div class="tab-content" data-tab="${idx}">${renderNode(child)}</div>`;
            }).join('');
            const tabItems = node.children.map((child, idx) => {
                const tabLabel = child.props.tabLabel || `Tab ${idx + 1}`;
                const badgeValue = child.props.badgeValue || '';
                return `<div class="tab-item ${idx === 0 ? 'active' : ''}" data-tab="${idx}">
                    ${escapeHtml(tabLabel)}
                    ${badgeValue ? `<span class="tab-badge">${escapeHtml(String(badgeValue))}</span>` : ''}
                </div>`;
            }).join('');
            baseHtml = `<div class="tab-view"${style}>
                <div class="tab-contents">${tabs}</div>
                <div class="tab-bar">${tabItems}</div>
            </div>`;
            break;
            
        case 'AsyncImage':
            const imageUrl = node.props.url || '';
            baseHtml = `<div class="async-image"${style}>
                <img src="${escapeHtml(imageUrl)}" alt="Async Image" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
                <div class="image-placeholder" style="display:none;">📷</div>
            </div>`;
            break;
            
        case 'TextEditor':
            const editorText = node.props.text || '';
            baseHtml = `<textarea class="text-editor"${style} placeholder="Enter text...">${escapeHtml(editorText)}</textarea>`;
            break;
            
        case 'DisclosureGroup':
            const disclosureLabel = node.props.label || 'Disclosure';
            const disclosureContent = node.children.map(renderNode).join('');
            baseHtml = `<details class="disclosure-group"${style}>
                <summary class="disclosure-label">${escapeHtml(disclosureLabel)}</summary>
                <div class="disclosure-content">${disclosureContent}</div>
            </details>`;
            break;
            
        case 'Custom': {
            const customText = node.props.text ? `<div class="custom-view-text">${escapeHtml(node.props.text)}</div>` : '';
            baseHtml = `<div class="custom-view"${style}><span class="custom-view-name">${escapeHtml(node.props.name ?? 'View')}</span>${customText}${node.children.map(renderNode).join('')}</div>`;
            break;
        }
        default:
            baseHtml = `<div class="custom"${style}>${escapeHtml(node.kind)}</div>`;
    }
    
    // Wrap with overlay if present
    if (overlayModifier && overlayModifier.args.content) {
        const overlayContent = renderNode(overlayModifier.args.content);
        return `<div class="overlay-container" style="position: relative;">
            ${baseHtml}
            <div class="overlay-content" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none;">
                ${overlayContent}
            </div>
        </div>`;
    }
    
    // Add animation indicator badge if animation modifier present
    const animationModifier = node.modifiers?.find(m => m.name === 'animation');
    if (animationModifier) {
        return `<div style="position: relative; display: inline-block;">
            ${baseHtml}
            <div class="animation-badge" title="Animated">🎬</div>
        </div>`;
    }
    
    // Add state property badges if present
    if (node.stateProperties && node.stateProperties.length > 0) {
        const badges = node.stateProperties.map(prop => {
            const icon = prop.type === 'State' ? '📦' : 
                        prop.type === 'Binding' ? '🔗' : 
                        prop.type === 'StateObject' ? '🎯' :
                        prop.type === 'ObservedObject' ? '👁️' :
                        prop.type === 'EnvironmentObject' ? '🌍' : '⚙️';
            const title = `@${prop.type} ${prop.name}${prop.valueType ? ': ' + prop.valueType : ''}${prop.initialValue !== undefined ? ' = ' + prop.initialValue : ''}`;
            return `<div class="state-badge" title="${escapeHtml(title)}">${icon}</div>`;
        }).join('');
        
        return `<div style="position: relative;">
            ${baseHtml}
            <div class="state-badges">${badges}</div>
        </div>`;
    }
    
    return baseHtml;
}

/**
 * Render a ForEach by expanding its row template
 */
function renderForEach(node: ViewNode): string {
    if (!node.props.rowTemplate) {
        return '<div class="foreach"></div>';
    }
    
    let iterations = 0;
    const items: any[] = [];
    
    // Determine iteration count from range or array
    if (node.props.forEachRange) {
        const { start, end } = node.props.forEachRange;
        iterations = end - start;
        for (let i = start; i < end; i++) {
            items.push(i);
        }
    } else if (node.props.forEachItems) {
        iterations = node.props.forEachItems.length;
        items.push(...node.props.forEachItems);
    }
    
    // Clone and render the row template for each iteration
    const rows: string[] = [];
    for (let i = 0; i < iterations; i++) {
        const clonedTemplate = cloneViewNode(node.props.rowTemplate);
        rows.push(renderNode(clonedTemplate));
    }
    
    return `<div class="foreach">${rows.join('')}</div>`;
}

/**
 * Map SwiftUI gradient points to CSS positions
 */
function mapGradientPoint(point: string): { x: number; y: number } {
    const pointMap: Record<string, { x: number; y: number }> = {
        'top': { x: 50, y: 0 },
        'bottom': { x: 50, y: 100 },
        'leading': { x: 0, y: 50 },
        'trailing': { x: 100, y: 50 },
        'topLeading': { x: 0, y: 0 },
        'topTrailing': { x: 100, y: 0 },
        'bottomLeading': { x: 0, y: 100 },
        'bottomTrailing': { x: 100, y: 100 },
        'center': { x: 50, y: 50 }
    };
    return pointMap[point] || { x: 50, y: 50 };
}

/**
 * Calculate gradient angle from start and end points
 */
function calculateGradientAngle(start: { x: number; y: number }, end: { x: number; y: number }): number {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const angle = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
    return Math.round(angle);
}

/**
 * Deep clone a ViewNode
 */
function cloneViewNode(node: ViewNode): ViewNode {
    return {
        kind: node.kind,
        props: { ...node.props },
        modifiers: node.modifiers ? [...node.modifiers.map(m => ({ ...m, args: { ...m.args } }))] : [],
        children: node.children ? node.children.map(cloneViewNode) : []
    };
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}
