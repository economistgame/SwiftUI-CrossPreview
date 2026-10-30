# Changelog

All notable changes to the SwiftUI CrossPreview extension will be documented in this file.

## [1.4.13] - 2026-10-30

### Added
- **`switch` y `if/else` en `body`** – El parser de respaldo resuelve el control de flujo: muestra el `case` (o la rama del `if`) que corresponde al valor inicial declarado de la variable (`@State`, `@Published`, `var`…). Si no puede deducirlo, usa el primer `case` o la primera rama.
- **`Image(systemName:)`** en el parser de respaldo.

### Fixed
- Vistas duplicadas en el preview cuando la indentación era mayor que la longitud de la vista (p. ej. `NavigationLink` repetidos).
- Error "Could not parse body content" cuando el `body` empezaba con `switch` o `if`.
- Compilación en CI: `npm ci --ignore-scripts` para no compilar los módulos nativos de tree-sitter.

## [1.3.0] - 2025-01-XX

### Added - Navigation & App Structure

#### PNG Export ⭐ NEW
- **One-Click Export** - Export preview as high-resolution PNG image (2x scale)
- **Header Button** - Prominent "📸 Export PNG" button in header for easy access
- **Auto Timestamp** - Files saved with ISO timestamp (e.g., swiftui-preview-2025-01-21T14-30-45.png)
- **Visual Feedback** - Button shows "⏳ Exporting..." then "✅ Exported!" confirmation
- **Perfect for Documentation** - Share crisp previews with team or include in design docs

#### State Visualization ⭐ NEW
- **@State Badge** - Visual indicator for @State properties with 📦 icon
- **@Binding Badge** - Visual indicator for @Binding properties with 🔗 icon
- **@StateObject Badge** - Visual indicator for @StateObject properties with 🎯 icon
- **@ObservedObject Badge** - Visual indicator for @ObservedObject properties with 👁️ icon
- **@EnvironmentObject Badge** - Visual indicator for @EnvironmentObject properties with 🌍 icon
- **@Environment Badge** - Visual indicator for @Environment properties with ⚙️ icon
- **Property Details** - Hover tooltip shows property name, type, and initial value

#### New Navigation Views (4 views)
- **NavigationView** - Container for navigation-based interfaces with navigation bar
- **NavigationStack** - iOS 16+ navigation container with stack-based navigation
- **NavigationLink** - Interactive element for navigating to destination views
- **NavigationSplitView** - Multi-column navigation interface (sidebar + detail)

#### New App Structure Views (1 view)
- **TabView** - Tab-based interface with tab bar at bottom

#### New Content Views (3 views)
- **AsyncImage** - Remote image loader with URL support
- **TextEditor** - Multi-line text input field (like UITextView)
- **DisclosureGroup** - Expandable/collapsible content section

#### New Navigation Modifiers (8 modifiers)
- `.navigationTitle(_:)` - Set title in navigation bar
- `.navigationBarTitleDisplayMode(_:)` - Control title size (.large, .inline, .automatic)
- `.toolbar()` - Add toolbar to navigation bar
- `.toolbarBackground(_:)` - Set toolbar background color
- `.navigationBarBackButtonHidden(_:)` - Hide back button
- `.tabItem(_:)` - Configure tab bar item appearance
- `.badge(_:)` - Display badge on tab or list item
- `.searchable()` - Make view searchable with search bar

#### New Additional Modifiers (5 modifiers)
- `.id(_:)` - Assign identifier to view for animations/transitions
- `.refreshable()` - Add pull-to-refresh functionality
- `.swipeActions()` - Add swipe gesture actions
- `.contextMenu()` - Add context menu on long press
- `.sheet(_:)` / `.fullScreenCover(_:)` - Present modal views
- `.alert(_:)` - Show alert dialog

### Enhanced
- Added tab switching interactivity in TabView
- Improved navigation bar rendering with proper title display
- Added visual indicators for disclosure group expansion state

## [1.2.0] - 2025-11-21

### Added - Major Feature Expansion (60+ new features)

#### New Input Controls (6 views)
- **Slider** - Range selector with customizable min/max values and styling
- **Stepper** - Increment/decrement control with +/- buttons
- **DatePicker** - Date/time selection input with native styling
- **ColorPicker** - Color selection input with color picker widget
- **ProgressView** - Loading spinner (indeterminate) or progress bar (determinate)
- **Menu** - Dropdown menu with button and content items

#### New Layout Views (5 views)
- **LazyVStack** - Vertically lazy-loaded stack for efficient rendering
- **LazyHStack** - Horizontally lazy-loaded stack for scrolling content
- **Grid** - SwiftUI 4.0 grid layout with GridRow support
- **Group** - Logical grouping container without layout effect
- **GeometryReader** - Container that provides access to size and position

#### New UI Elements (2 views)
- **Link** - Hyperlink with destination URL
- **Menu** (also listed under controls) - Context menu with dropdown

#### New Layout Modifiers (6 modifiers)
- `.position(x:y:)` - Absolute positioning within parent container
- `.aspectRatio(_:contentMode:)` - Aspect ratio constraint with fit/fill modes
- `.scaledToFit()` - Scale content to fit within bounds
- `.scaledToFill()` - Scale content to fill bounds (may clip)
- `.clipShape(_:)` - Clip view to specific shape (Circle, Capsule, RoundedRectangle)
- `.mask(_:)` - Apply view as mask to another view

#### New Visual Effect Modifiers (6 modifiers)
- `.foregroundStyle(_:)` - Modern color styling API (iOS 15+)
- `.tint(_:)` - Accent color modifier for interactive elements
- `.brightness(_:)` - Adjust brightness (-1 to +1)
- `.contrast(_:)` - Adjust contrast (0 to 2+)
- `.saturation(_:)` - Adjust color saturation (0 = grayscale, 2+ = vibrant)
- `.hueRotation(_:)` - Rotate hue by degrees (0-360)

#### New Interaction Modifiers (3 modifiers)
- `.onLongPressGesture()` - Long press gesture handler
- `.disabled(_:)` - Disable user interaction with grayed-out appearance
- (`.onTapGesture()` was already supported in v1.1.0)

#### New Lifecycle Modifiers (2 modifiers)
- `.onAppear()` - Called when view appears (no visual effect)
- `.onDisappear()` - Called when view disappears (no visual effect)

#### New Text Modifiers (4 modifiers)
- `.fontWeight(_:)` - Custom font weight (ultraLight to black)
- `.kerning(_:)` - Adjust letter spacing
- `.tracking(_:)` - Alternate API for letter spacing
- `.baselineOffset(_:)` - Vertical text offset from baseline

#### New Animation Modifier (1 modifier)
- `.transition(_:)` - Enter/exit animations (slide, scale, opacity, move)

#### New Accessibility Modifiers (3 modifiers)
- `.accessibilityLabel(_:)` - Screen reader label
- `.accessibilityHint(_:)` - Usage hint for assistive technologies
- `.accessibilityValue(_:)` - Current value description

### Implementation Complete

#### Parser (src/parser/swiftParser.ts)
- Added parsing for all 11 new view types
- Added argument extraction for all 24 new modifiers
- Updated ViewNode type union in viewTree.ts
- Dedicated parse functions for complex views (Slider, Stepper, etc.)
- Full regex fallback support for all new views

#### Server-Side Renderer (src/renderer/renderHtml.ts)
- All new views render correctly in renderNode()
- All new modifiers handled in buildStyle()
- CSS filter transformations (brightness, contrast, saturate, hue-rotate)
- HTML structures for all input controls
- Progress bar and loading spinner implementations

#### Client-Side Renderer (src/extension.ts)
- Complete CSS styling for all new views
- iOS-style slider with custom track and thumb
- Stepper controls with +/- buttons
- DatePicker and ColorPicker with native input styling
- ProgressView with determinate and indeterminate states
- Menu with dropdown functionality
- Lazy stacks and Grid layouts
- Client-side buildStyle() supports all new modifiers
- Client-side renderNode() supports all new views

#### Test Files Created
- **InputControlsDemo.swift** - Slider, Stepper, DatePicker, ColorPicker examples
- **ProgressMenuDemo.swift** - ProgressView and Menu component demos
- **LazyLayoutsDemo.swift** - LazyVStack, LazyHStack, Grid, Group, GeometryReader
- **AdvancedModifiersDemo.swift** - Position, aspect ratio, clip shape, scaling, interaction
- **ColorAdjustmentsDemo.swift** - Brightness, contrast, saturation, hue rotation
- **AccessibilityDemo.swift** - Accessibility modifiers with best practices

### Coverage Summary

**Total Views: 34** (was 23 in v1.1.0)
- Layouts: 8 (VStack, HStack, ZStack, LazyVStack, LazyHStack, Grid, Group, GeometryReader)
- Content: 3 (Text, Image, Spacer)
- Lists: 5 (List, Form, Section, ScrollView, ForEach)
- Controls: 10 (Button, Toggle, Picker, TextField, SecureField, Slider, Stepper, DatePicker, ColorPicker, Menu)
- Shapes: 5 (Rectangle, Circle, RoundedRectangle, Capsule, Ellipse)
- Graphics: 2 (LinearGradient, RadialGradient)
- UI Elements: 4 (Divider, Label, ProgressView, Link)

**Total Modifiers: 57** (was 30 in v1.1.0)
- Layout: 8 (padding, frame, offset, position, aspectRatio, scaledToFit, scaledToFill)
- Colors: 5 (foregroundColor, foregroundStyle, tint, background, backgroundMaterial)
- Glass: 3 (ultraThinMaterial, thinMaterial, regularMaterial)
- Typography: 13 (font, fontWeight, bold, italic, underline, strikethrough, multilineTextAlignment, lineLimit, kerning, tracking, baselineOffset)
- Visual: 12 (cornerRadius, shadow, opacity, blur, border, clipped, brightness, contrast, saturation, hueRotation)
- Shapes: 2 (fill, stroke)
- Transform: 4 (rotationEffect, scaleEffect, offset, clipShape, mask)
- Animation: 2 (animation, transition)
- Interaction: 3 (onTapGesture, onLongPressGesture, disabled)
- Lifecycle: 2 (onAppear, onDisappear)
- Accessibility: 3 (accessibilityLabel, accessibilityHint, accessibilityValue)
- Overlay: 1 (overlay)

### Performance & Quality
- All views render efficiently with proper CSS styling
- Lazy stacks support performance optimization for large lists
- Filter effects use CSS filters for smooth rendering
- Comprehensive test coverage with 6 new demo files
- No breaking changes - fully backward compatible

### Breaking Changes
None. All changes are additive and backwards compatible with v1.1.0.

## [1.1.0] - 2025-11-21

### Added
- **List, Form, Section, ScrollView support** - Full container view rendering with automatic scrolling
- **ForEach support** - Parses range patterns (`1..<4`) and array literals (`["One", "Two"]`) with template expansion
- **Comment support** - Single-line `//` comments are now properly handled and stripped during parsing
- **Zoom-to-fit scaling** - Device mockup automatically scales to fit VS Code window size
- **Fixed device dimensions** - Device mockup sizes remain constant regardless of content (430×880 phone, 820×1100 tablet, 1024×768 desktop)
- **Scrollable containers** - List/Form/ScrollView automatically become scrollable when content exceeds height
- **System gray background** - Extension preview area uses iOS-style system gray background (#f2f2f7)
- **Device menu moved to top** - Better UI layout with device selector positioned above mockup

### Fixed
- ForEach no longer prevents sibling Text elements from rendering
- VStack now properly displays all children vertically with correct spacing
- Frame modifier only affects content width/height, not device mockup dimensions
- Improved regex fallback parser with proper child node parsing
- Text nodes before and after ForEach now render correctly

### Changed
- Updated device screen background to white for better content visibility
- Improved parsing logic to handle complex nested structures (VStack > List > ForEach)
- Enhanced CSS for better list and form rendering with proper flex layouts
- Device mockup uses CSS transforms for zoom instead of changing dimensions

## [0.0.2] - 2025-11-21

### Added
- **New Visual Modifiers**: shadow, opacity, blur, glass materials, overlay, multilineTextAlignment, lineLimit
- **Glass/Material Backgrounds**: Support for .ultraThinMaterial, .thinMaterial, .regularMaterial with backdrop blur effects
- **Stack Alignment & Spacing**: VStack(alignment: .leading, spacing: 16) parameter parsing
- **Overlay Support**: Layer content on top of base views with centered positioning
- **Text Formatting**: multilineTextAlignment and lineLimit for precise text layout
- **Xcode-Style UI**: iPhone mockup with Dynamic Island, dark background, bottom device controls
- **View Name Display**: Shows "Previewing: MyView" based on struct name
- **Comprehensive Test Files**: ModifiersTest.swift, GlassCardDemo.swift, SimpleModifiers.swift

### Changed
- Updated webview UI to match Xcode simulator appearance
- Enhanced CSS renderer with material styles and visual effects
- Improved parser to handle new modifier types in both tree-sitter and regex modes

### Fixed
- Cross-platform compatibility with regex fallback parser
- Material background detection and rendering
- Stack props handling for alignment and spacing

## [0.0.1] - Initial Release

### Added
- Live preview with auto-update (300ms debounce)
- Tree-sitter Swift parser with regex fallback
- Core SwiftUI views: VStack, HStack, ZStack, Text, Image, Spacer
- Basic modifiers: padding, foregroundColor, background, font, frame, cornerRadius
- 15 SwiftUI colors support
- 11 font styles support
- Device presets (Phone/Tablet/Desktop)
- Error UI with detailed diagnostics
- HTML/CSS renderer
- VS Code command: "SwiftUI CrossPreview: Open Preview"
