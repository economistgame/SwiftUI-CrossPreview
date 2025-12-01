import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

let currentPanel: vscode.WebviewPanel | undefined = undefined;

export function createPreviewPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
    // If we already have a panel, dispose it and create a new one to force reload
    if (currentPanel) {
        currentPanel.dispose();
        currentPanel = undefined;
    }

    // Create a new panel with unique ID to bust cache
    const panel = vscode.window.createWebviewPanel(
        'swiftUIPreviewV2',
        'SwiftUI CrossPreview',
        vscode.ViewColumn.Two,
        {
            enableScripts: true,
            retainContextWhenHidden: false, // Don't retain to force fresh load
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'media')
            ]
        }
    );

    currentPanel = panel;

    // Set HTML content
    panel.webview.html = getHtmlContent(context, panel.webview);

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(
        message => {
            switch (message.type) {
                case 'ready':
                    console.log('Webview is ready');
                    break;
            }
        },
        undefined,
        context.subscriptions
    );

    // Handle disposal
    panel.onDidDispose(() => {
        currentPanel = undefined;
    });

    return panel;
}

function getHtmlContent(context: vscode.ExtensionContext, webview: vscode.Webview): string {
    const htmlPath = path.join(context.extensionPath, 'media', 'preview.html');
    
    try {
        let html = fs.readFileSync(htmlPath, 'utf8');
        
        // Add cache busting version
        const version = Date.now();
        html = html.replace('</head>', `<meta name="version" content="${version}"></head>`);
        
        // Replace placeholders with webview URIs if needed
        const mediaUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media'));
        html = html.replace(/\{\{mediaUri\}\}/g, mediaUri.toString());
        
        return html;
    } catch (error) {
        console.error('Failed to read preview.html:', error);
        return getFallbackHtml();
    }
}

function getFallbackHtml(): string {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>SwiftUI CrossPreview</title>
    </head>
    <body>
        <h1>SwiftUI CrossPreview</h1>
        <p>Error loading preview.html</p>
    </body>
    </html>`;
}
