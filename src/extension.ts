import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SessionManager } from './sessionManager';
import { SessionTreeProvider } from './sessionTreeProvider';
import { ProcessManager } from './processManager';
import { CodexProcessManager } from './codexProcessManager';
import { HttpServer } from './httpServer';
import { ConversationManager } from './conversationManager';
import { ensureDaemonRunning } from './daemon/launcher';
import { ClaudeProvider } from './providers/claudeProvider';
import { CodexProvider } from './providers/codexProvider';
import { ConversationProvider } from './providers/types';
import { ConversationRecord, SessionSnapshot } from './types';
import { getDebugLogPath, logDebug } from './debugLog';
import { SessionIndexService } from './sessionIndexService';
import { SessionCenterPanel } from './sessionCenterPanel';
import { TerminalRegistry } from './terminalRegistry';
import { TaskRegistry } from './taskRegistry';
import { TaskDraftRegistry } from './taskDraftRegistry';
import { NoteRegistry } from './noteRegistry';
import { WorkspaceEntityIndexService } from './workspaceEntityIndexService';
import { showWorkspaceSearch } from './workspaceSearch';
import { NoteSnapshot, WorkspaceEntity, WorkspaceRelatedEntity } from './workspaceEntities';
import { buildWorkspaceArtifact, createRelatedEntity, parseWorkspaceArtifact, WorkspaceNoteMeta, WorkspaceTaskDraftMeta } from './workspaceArtifacts';
import { AutoApprovalManager } from './autoApprovalManager';
import { WorkingSessionTracker } from './workingSessionTracker';
import { CreateSessionHandoffInput, SessionHandoffArtifactKind, SessionHandoffService } from './sessionHandoffService';
import { SessionHandoffQueueProcessor } from './sessionHandoffQueue';
import { ensureSessionHandoffTooling } from './sessionTooling';

const g = globalThis as any;
const AUTO_APPROVE_PERMISSIONS_KEY = 'sessionCenterAutoApprovePermissions';

type PatchOutcome = {
  changed: boolean;
  reports: string[];
  warnings: string[];
};

type PendingFileWrite = {
  path: string;
  content: string;
};

type PatchAvailability = 'ready' | 'reload_required' | 'invalid';

type CodexExtensionTarget = {
  extensionPath: string;
  version: string | null;
};

type BundleSelection = {
  selected?: string;
  warning?: string;
};

function summarizePatchState(label: string, state: 'applied' | 'already_present' | 'anchor_missing' | 'missing_file' | 'write_failed'): string {
  return `${label}: ${state}`;
}

function selectBundle(files: string[], pattern: RegExp, label: string): BundleSelection {
  const matches = files.filter(file => pattern.test(file)).sort();
  if (matches.length === 0) {
    return { warning: `${label}: missing_file` };
  }
  if (matches.length > 1) {
    return {
      selected: matches[0],
      warning: `${label}: multiple_matches(${matches.length}) using ${matches[0]}`,
    };
  }
  return { selected: matches[0] };
}

function stripLegacySelectionNoteBridgeScripts(content: string): string {
  return content.replace(
    /(?:^|\n);\(\(\)=>\{try\{if\(window\.__vibeControlSelectionNoteBridgeV(?:2|3|5|6|7)\)return;[\s\S]*?\*\/(?:\n|$)/g,
    '\n',
  );
}

function buildWebviewSelectionNoteBridgeScript(provider: 'claude' | 'codex'): string {
  const providerLiteral = JSON.stringify(provider);
  return [
    '(()=>{try{',
    'if(window.__vibeControlSelectionNoteBridgeV8)return;',
    'window.__vibeControlSelectionNoteBridgeV8=!0;',
    'const acquire=typeof acquireVsCodeApi==="function"?acquireVsCodeApi:null;',
    'const vscode=acquire?acquire():null;',
    'const hostBridge=typeof A!=="undefined"&&A?A:typeof E!=="undefined"&&E?E:null;',
    'function sendHost(type,payload){let sent=!1;if(hostBridge&&typeof hostBridge.dispatchMessage==="function"){try{hostBridge.dispatchMessage(type,payload||{});sent=!0;}catch{}}if(vscode){try{vscode.postMessage({type,payload});sent=!0;}catch{}}if(!sent&&hostBridge&&typeof hostBridge.dispatchHostMessage==="function"){try{hostBridge.dispatchHostMessage({type,payload});sent=!0;}catch{}}return sent;}',
    'function logHost(message){try{if(hostBridge&&typeof hostBridge.dispatchMessage==="function"){hostBridge.dispatchMessage("log-message",{level:"info",message});return}if(vscode){vscode.postMessage({type:"log-message",level:"info",message})}}catch{}}',
    'if(!hostBridge&&!vscode)return;',
    'const styleId="vibe-control-selection-note-style-v8";',
    'const menuId="vibe-control-selection-note-menu-v8";',
    'const maxTextLength=12000;',
    `const provider=${providerLiteral};`,
    'let menu=null,lastPayload=null,selectionUpdateTimer=null,lastSerializedPayload="";',
    'const knownRoots=new WeakSet();',
    'let rootObserver=null;',
    'function ensureStyle(){if(document.getElementById(styleId))return;const style=document.createElement("style");style.id=styleId;style.textContent="#"+menuId+"{position:fixed;z-index:2147483647;display:none;min-width:148px;padding:6px;background:var(--vscode-menu-background, #1f1f1f);color:var(--vscode-menu-foreground, #cccccc);border:1px solid var(--vscode-menu-border, rgba(255,255,255,0.16));border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.24);font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}#"+menuId+" button{display:block;width:100%;border:0;background:transparent;color:inherit;text-align:left;padding:8px 10px;border-radius:6px;cursor:pointer}#"+menuId+" button:hover{background:var(--vscode-list-hoverBackground, rgba(255,255,255,0.08));}";document.head.appendChild(style);}',
    'function ensureMenu(){if(menu)return menu;menu=document.createElement("div");menu.id=menuId;const addBtn=document.createElement("button");addBtn.textContent="Add To Note";addBtn.addEventListener("click",()=>{if(!lastPayload)return;sendHost("vibe-control-selection-to-note",lastPayload);hideMenu();});const copyBtn=document.createElement("button");copyBtn.textContent="Copy";copyBtn.addEventListener("click",async()=>{if(!lastPayload)return;try{if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(lastPayload.text);}catch{}hideMenu();});menu.appendChild(addBtn);menu.appendChild(copyBtn);menu.addEventListener("mousedown",e=>e.stopPropagation(),!0);document.body.appendChild(menu);return menu;}',
    'function hideMenu(){if(menu)menu.style.display="none";}',
    'function normalizeText(value){const text=String(value||"").replace(/\\s+/g," ").trim();return text.length>maxTextLength?text.slice(0,maxTextLength):text;}',
    'function selectionToText(selection){if(!selection||selection.rangeCount===0||selection.isCollapsed)return"";try{const text=normalizeText(selection.toString());if(text)return text;}catch{}try{let combined="";for(let index=0;index<selection.rangeCount;index+=1){const range=selection.getRangeAt(index);const fragment=range.cloneContents();const text=normalizeText(fragment.textContent||"");if(text)combined+=(combined?"\\n\\n":"")+text;}return normalizeText(combined);}catch{return"";}}',
    'function controlSelectionText(element){if(!(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement))return"";try{const start=typeof element.selectionStart==="number"?element.selectionStart:0;const end=typeof element.selectionEnd==="number"?element.selectionEnd:start;if(end<=start)return"";return normalizeText(element.value.slice(start,end));}catch{return"";}}',
    'function collectShadowRoots(){const roots=[];const visited=new WeakSet();const pending=[];if(document.documentElement)pending.push(document.documentElement);while(pending.length>0){const node=pending.pop();if(!(node instanceof Element))continue;const shadow=node.shadowRoot;if(shadow&&!visited.has(shadow)){visited.add(shadow);roots.push(shadow);for(const child of Array.from(shadow.children)){pending.push(child);}}for(const child of Array.from(node.children)){pending.push(child);}}return roots;}',
    'function readSelectionText(){try{let best="";const consider=text=>{if(text.length>best.length)best=text;};consider(selectionToText(window.getSelection?window.getSelection():null));consider(selectionToText(document.getSelection?document.getSelection():null));consider(controlSelectionText(document.activeElement));for(const root of collectShadowRoots()){const getter=typeof root.getSelection==="function"?root.getSelection.bind(root):null;consider(selectionToText(getter?getter():null));consider(controlSelectionText(root.activeElement));}return normalizeText(best);}catch{return"";}}',
    'function currentRoute(){try{return String((window.location?.pathname||"")+(window.location?.hash||""));}catch{return"";}}',
    'function showMenu(x,y,payload){const el=ensureMenu();lastPayload=payload;el.style.display="block";const width=el.offsetWidth||148;const height=el.offsetHeight||76;const left=Math.min(x,Math.max(8,window.innerWidth-width-8));const top=Math.min(y,Math.max(8,window.innerHeight-height-8));el.style.left=left+"px";el.style.top=top+"px";}',
    'function emitSelectionUpdate(){const text=readSelectionText();const payload=text?{provider,text,route:currentRoute(),title:document.title||""}:null;const serialized=JSON.stringify(payload);if(serialized===lastSerializedPayload)return;lastSerializedPayload=serialized;sendHost("vibe-control-selection-updated",payload);}',
    'function emitSelectionResponse(requestId){const payload={provider,text:readSelectionText(),requestId:typeof requestId==="string"?requestId:"",route:currentRoute(),title:document.title||""};logHost(`Vibe Control Selection Bridge: response provider=${provider} length=${payload.text.length} requestId=${payload.requestId}`);sendHost("vibe-control-selection-response",payload);}',
    'function scheduleSelectionUpdate(){if(selectionUpdateTimer)clearTimeout(selectionUpdateTimer);selectionUpdateTimer=setTimeout(()=>{selectionUpdateTimer=null;emitSelectionUpdate();},120);}',
    'function handleContextMenu(event){const text=readSelectionText();if(!text){hideMenu();return;}event.preventDefault();showMenu(event.clientX,event.clientY,{provider,text,route:currentRoute(),title:document.title||""});scheduleSelectionUpdate();}',
    'function bindRoot(root){if(!root||knownRoots.has(root))return;knownRoots.add(root);["selectionchange","mouseup","keyup"].forEach(type=>root.addEventListener(type,()=>{scheduleSelectionUpdate();},!0));root.addEventListener("contextmenu",handleContextMenu,!0);}',
    'function bindKnownRoots(){bindRoot(document);for(const root of collectShadowRoots()){bindRoot(root);}}',
    'function ensureRootObserver(){if(rootObserver||!document.documentElement)return;rootObserver=new MutationObserver(()=>{bindKnownRoots();scheduleSelectionUpdate();});rootObserver.observe(document.documentElement,{childList:!0,subtree:!0});}',
    'window.addEventListener("message",event=>{const message=event.data;if(message?.type!=="vibe-control-request-selection")return;logHost(`Vibe Control Selection Bridge: request provider=${provider} requestId=${typeof message.requestId==="string"?message.requestId:""}`);emitSelectionResponse(message.requestId);});',
    'document.addEventListener("mousedown",event=>{if(menu&&menu.contains(event.target))return;hideMenu();},!0);',
    'document.addEventListener("scroll",()=>hideMenu(),!0);',
    'window.addEventListener("blur",()=>{emitSelectionUpdate();logHost(`Vibe Control Selection Bridge: blur provider=${provider} length=${readSelectionText().length}`);hideMenu();});',
    'document.addEventListener("keydown",event=>{if(event.key==="Escape")hideMenu();});',
    'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",()=>{ensureStyle();ensureMenu();bindKnownRoots();ensureRootObserver();logHost(`Vibe Control Selection Bridge: ready provider=${provider}`);scheduleSelectionUpdate();},{once:!0});}else{ensureStyle();ensureMenu();bindKnownRoots();ensureRootObserver();logHost(`Vibe Control Selection Bridge: ready provider=${provider}`);scheduleSelectionUpdate();}',
    '}catch(error){console.error("[Vibe Control] selection note bridge failed",error)}})();',
  ].join('');
}

function patchClaudeExtension(): boolean {
  const claudeExt = vscode.extensions.getExtension('Anthropic.claude-code');
  if (!claudeExt) { return false; }

  let changed = false;
  const extJsPath = path.join(claudeExt.extensionPath, 'extension.js');
  if (!fs.existsSync(extJsPath)) { return false; }

  let content = fs.readFileSync(extJsPath, 'utf-8');

  if (!content.includes('__vibeControlCwd')) {
    const pattern = /(\w+)\.realpathSync\((\w+)\[0\]\|\|(\w+)\.homedir\(\)\)\.normalize\("NFC"\)/g;
    const patched = content.replace(pattern, (match) => `global.__vibeControlCwd||${match}`);
    if (patched !== content) { content = patched; changed = true; }
  }

  const cssMarker = '__vibeControlCSS';
  if (!content.includes(cssMarker)) {
    const templateStart = content.indexOf('return`<!DOCTYPE html>');
    if (templateStart >= 0) {
      const styleEnd = content.indexOf('</style>', templateStart);
      if (styleEnd >= 0) {
        const injectionPoint = styleEnd + '</style>'.length;
        const hideCSS = `\n        <style>/* ${cssMarker} */\n`
          + '          [class*="header_aqhumA"] { display: none !important; }\n'
          + '        </style>';
        content = content.substring(0, injectionPoint) + hideCSS + content.substring(injectionPoint);
        changed = true;
      }
    }
  }

  const renameMarker = '__vibeControlNoRename';
  if (!content.includes(renameMarker)) {
    const renameTarget = '.panelTab.title=z.request.title';
    const idx = content.indexOf(renameTarget);
    if (idx >= 0) {
      content = content.substring(0, idx) + `.panelTab.title/*${renameMarker}*/=this.panelTab.title` + content.substring(idx + renameTarget.length);
      changed = true;
    }
  }

  const selectionHostMarker = '__vibeControlClaudeSelectionHostV4';
  if (!content.includes(selectionHostMarker)) {
    const hostTarget = 'K.webview.onDidReceiveMessage((U)=>{this.output.info(`Received message from webview: ${JSON.stringify(U)}`),q?.fromClient(U)},null,this.disposables)';
    const hostReplacement = 'K.webview.onDidReceiveMessage((U)=>{let Z=Array.from(this.sessionPanels.entries()).find(([D,L])=>L===K)?.[0],Y=typeof U?.payload?.route==="string"&&/\\/local\\/[^/?#]+/.test(U.payload.route)?U.payload.route:void 0;if(U?.type==="vibe-control-selection-response"){let ee=U.payload&&typeof U.payload==="object"?U.payload:U,tt=typeof ee.requestId==="string"?ee.requestId:"",rr=this.pendingVibeControlSelectionRequests?.get(tt);if(rr){this.pendingVibeControlSelectionRequests.delete(tt),clearTimeout(rr.timeout),rr.resolve(typeof ee.text==="string"&&ee.text.trim().length>0?{provider:"claude",sessionId:Z,text:ee.text,route:Y,title:typeof ee.title==="string"?ee.title:void 0}:null)}return}if(U?.type==="vibe-control-selection-updated"){P0.commands.executeCommand("vibe-control.updateWebviewSelectionPayload",U.payload&&typeof U.payload?.text==="string"?{provider:"claude",sessionId:Z,text:U.payload.text,route:Y,title:typeof U.payload?.title==="string"?U.payload.title:void 0}:null);return}if(U?.type==="vibe-control-selection-to-note"){P0.commands.executeCommand("vibe-control.addSelectionToNoteFromWebviewPayload",{provider:"claude",sessionId:Z,text:typeof U.payload?.text==="string"?U.payload.text:"",route:Y,title:typeof U.payload?.title==="string"?U.payload.title:void 0});return}this.output.info(`Received message from webview: ${JSON.stringify(U)}`),q?.fromClient(U)},null,this.disposables)/*__vibeControlClaudeSelectionHostV4*/';
    if (content.includes(hostTarget)) {
      content = content.replace(hostTarget, hostReplacement);
      changed = true;
    }
  }

  const selectionRequestMethodMarker = '__vibeControlClaudeSelectionRequestMethodV1';
  if (!content.includes(selectionRequestMethodMarker)) {
    const requestMethodTarget = 'setActivePanel(K){for(let[V,B]of this.sessionPanels)if(B===K){this.activeSessionId=V,this.broadcastSessionStates();return}}broadcastSessionStates(){';
    const requestMethodReplacement = 'setActivePanel(K){for(let[V,B]of this.sessionPanels)if(B===K){this.activeSessionId=V,this.broadcastSessionStates();return}}async requestCurrentSelection(){let K=this.activeSessionId?this.sessionPanels.get(this.activeSessionId):Array.from(this.sessionPanels.values()).find(V=>V.active);if(!K)return null;let V=`vibe-control-selection-${Date.now()}-${Math.random().toString(16).slice(2)}`,B=this.pendingVibeControlSelectionRequests??(this.pendingVibeControlSelectionRequests=new Map);return await new Promise(j=>{let G=setTimeout(()=>{B.delete(V),j(null)},1500);B.set(V,{resolve:j,timeout:G});K.webview.postMessage({type:"vibe-control-request-selection",requestId:V})})}/*__vibeControlClaudeSelectionRequestMethodV1*/broadcastSessionStates(){';
    if (content.includes(requestMethodTarget)) {
      content = content.replace(requestMethodTarget, requestMethodReplacement);
      changed = true;
    }
  }

  const workingStateMarker = '__vibeControlClaudeWorkingStateV1';
  if (!content.includes(workingStateMarker)) {
    const workingStateTarget =
      'updateSessionState(K,V,B){this.sessionStates.set(K,{sessionId:K,state:V,title:B}),this.broadcastSessionStates()}';
    const workingStateReplacement =
      'updateSessionState(K,V,B){this.sessionStates.set(K,{sessionId:K,state:V,title:B}),P0.commands.executeCommand("vibe-control.updateProviderSessionWorkingState",{provider:"claude",sessionId:K,state:V}),this.broadcastSessionStates()}/*__vibeControlClaudeWorkingStateV1*/';
    if (content.includes(workingStateTarget)) {
      content = content.replace(workingStateTarget, workingStateReplacement);
      changed = true;
    }
  }

  const selectionRequestCommandMarker = '__vibeControlClaudeSelectionRequestCommandV1';
  if (!content.includes(selectionRequestCommandMarker)) {
    const requestCommandTarget = 'K.subscriptions.push(M4.commands.registerCommand("claude-vscode.newConversation",async()=>{Z.notifyCreateNewConversation()}));';
    const requestCommandReplacement = 'K.subscriptions.push(M4.commands.registerCommand("claude-vscode.newConversation",async()=>{Z.notifyCreateNewConversation()})),K.subscriptions.push(M4.commands.registerCommand("claude-vscode.requestCurrentSelection",async()=>await Z.requestCurrentSelection())),K.subscriptions.push(M4.commands.registerCommand("claude-code.requestCurrentSelection",async()=>await Z.requestCurrentSelection()))/*__vibeControlClaudeSelectionRequestCommandV1*/;';
    if (content.includes(requestCommandTarget)) {
      content = content.replace(requestCommandTarget, requestCommandReplacement);
      changed = true;
    }
  }

  const webviewPath = path.join(claudeExt.extensionPath, 'webview', 'index.js');
  const selectionBridgeMarker = '__vibeControlClaudeSelectionBridgeV8';
  if (fs.existsSync(webviewPath)) {
    const webviewContent = stripLegacySelectionNoteBridgeScripts(fs.readFileSync(webviewPath, 'utf-8'));
    if (!webviewContent.includes(selectionBridgeMarker)) {
      fs.writeFileSync(
        webviewPath,
        `${webviewContent}
;${buildWebviewSelectionNoteBridgeScript('claude')}/*${selectionBridgeMarker}*/
`,
        'utf-8',
      );
      changed = true;
    }
  }

  if (changed) {
    try { fs.writeFileSync(extJsPath, content, 'utf-8'); } catch { return false; }
  }
  return changed;
}
function listInstalledCodexExtensionDirs(baseDir: string): string[] {
  try {
    return fs.readdirSync(baseDir)
      .filter(name => name.startsWith('openai.chatgpt-'))
      .sort()
      .reverse()
      .map(name => path.join(baseDir, name));
  } catch {
    return [];
  }
}

function readCodexExtensionVersion(extensionPath: string): string | null {
  try {
    const packageJsonPath = path.join(extensionPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) { return null; }
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    return typeof packageJson?.version === 'string' ? packageJson.version : null;
  } catch {
    return null;
  }
}

function collectCodexExtensionTargets(): CodexExtensionTarget[] {
  const codexExt = vscode.extensions.getExtension('openai.chatgpt');
  if (codexExt) {
    return [{
      extensionPath: codexExt.extensionPath,
      version: typeof codexExt.packageJSON?.version === 'string'
        ? codexExt.packageJSON.version
        : readCodexExtensionVersion(codexExt.extensionPath),
    }];
  }

  const fallbackBaseDir = path.join(process.env.HOME || '', '.windsurf-server', 'extensions');
  const [latestFallback] = listInstalledCodexExtensionDirs(fallbackBaseDir);
  return latestFallback ? [{
    extensionPath: latestFallback,
    version: readCodexExtensionVersion(latestFallback),
  }] : [];
}

function patchCodexExtensionAtPath(target: CodexExtensionTarget): PatchOutcome {
  const replaceAllLiteral = (source: string, target: string, replacement: string): string =>
    source.includes(target) ? source.split(target).join(replacement) : source;
  const collectMissingChecks = (
    source: string,
    checks: Array<{ needle: string; label: string }>,
  ): string[] => checks.filter(check => !source.includes(check.needle)).map(check => check.label);

  const extensionPath = target.extensionPath;
  const reports: string[] = [];
  const warnings: string[] = [];
  let overallChanged = false;
  const pendingWrites: PendingFileWrite[] = [];
  const extJsPath = path.join(extensionPath, 'out', 'extension.js');
  if (!fs.existsSync(extJsPath)) {
    reports.push(summarizePatchState('extension-host', 'missing_file'));
    return { changed: false, reports, warnings };
  }

  let content = fs.readFileSync(extJsPath, 'utf-8');
  let extChanged = false;
  const addBroadcastHandlerTarget =
    'addBroadcastHandler(e,r){return this.broadcastHandlers.set(e,r),()=>{this.broadcastHandlers.delete(e)}}';
  const handleBroadcastTarget =
    'async handleBroadcast(e){let r=this.broadcastHandlers.get(e.method);if(this.anyBroadcastHandlers.size>0&&await Promise.all(Array.from(this.anyBroadcastHandlers).map(n=>n(e))),r){await r(e);return}this.anyBroadcastHandlers.size===0&&this.logger.warning("Received broadcast but no handler is configured",{safe:{method:e.method},sensitive:{}})}';
  const originBoundFollowerResponsePattern =
    /if\(!o\|\|o\.origin!==e\)\{this\.logger\.warning\("Received [^"]+ response for unknown request id",\{safe:\{requestId:n\},sensitive:\{\}\}\);return\}/g;

  const openInTargetMarker = '__vibeControlOpenInTargetSafe';
  if (!content.includes(openInTargetMarker)) {
    const openInTargetReplacements: Array<[string, string]> = [
      [
        '"open-in-targets":async()=>{throw new Error("open-in-target not supported in extension")},',
        `"open-in-targets":async()=>({preferredTarget:null,targets:[],availableTargets:[]})/*${openInTargetMarker}*/,`,
      ],
      [
        '"set-preferred-app":async()=>{throw new Error("open-in-target not supported in extension")}',
        `"set-preferred-app":async()=>({success:!0})/*${openInTargetMarker}*/`,
      ],
    ];
    for (const [target, replacement] of openInTargetReplacements) {
      const nextContent = replaceAllLiteral(content, target, replacement);
      if (nextContent !== content) {
        content = nextContent;
        extChanged = true;
      }
    }
  }

  const stateMarker = '__vibeControlCodexState';
  const prefillMarker = '__vibeControlCodexPrefill';
  const openConversationCommandMarker = '__vibeControlOpenConversationCommand';
  const requestSelectionCommandMarker = '__vibeControlRequestSelectionCommand';
  const autoApproveSweepCommandMarker = '__vibeControlAutoApproveSweepCommand';
  if (!content.includes(stateMarker)) {
    const target = 'this.editorPanels.set(r,{ready:!1,pendingMessages:[],initialRoute:i==null?o.path:`/local/${i}`}),';
    const replacement = `this.editorPanels.set(r,{ready:!1,pendingMessages:global.${stateMarker}&&i==null?[{type:"navigate-to-route",path:"/",state:global.${stateMarker}}]:[],initialRoute:i==null?(global.${stateMarker}?"/":o.path):\`/local/\${i}\`}),global.${stateMarker}=void 0,`;
    if (content.includes(target)) {
      content = content.replace(target, replacement);
      extChanged = true;
    }
  }

  const brokenPatch = 'let vcs=global.__vibeControlCodexState&&i==null?global.__vibeControlCodexState:void 0;global.__vibeControlCodexState=void 0;this.editorPanels.set(r,{ready:!1,pendingMessages:vcs?[{type:"navigate-to-route",path:o.path,state:vcs}]:[],initialRoute:i==null?o.path:`/local/${i}`}),';
  if (content.includes(brokenPatch)) {
    content = content.replace(
      brokenPatch,
      'this.editorPanels.set(r,{ready:!1,pendingMessages:global.__vibeControlCodexState&&i==null?[{type:"navigate-to-route",path:"/",state:global.__vibeControlCodexState}]:[],initialRoute:i==null?(global.__vibeControlCodexState?"/":o.path):`/local/${i}`}),global.__vibeControlCodexState=void 0,',
    );
    extChanged = true;
  }

  const legacyPatched = 'this.editorPanels.set(r,{ready:!1,pendingMessages:global.__vibeControlCodexState&&i==null?[{type:"navigate-to-route",path:"/",state:global.__vibeControlCodexState}]:[],initialRoute:i==null?o.path:`/local/${i}`}),global.__vibeControlCodexState=void 0,';
  if (content.includes(legacyPatched)) {
    content = content.replace(
      legacyPatched,
      'this.editorPanels.set(r,{ready:!1,pendingMessages:global.__vibeControlCodexState&&i==null?[{type:"navigate-to-route",path:"/",state:global.__vibeControlCodexState}]:[],initialRoute:i==null?(global.__vibeControlCodexState?"/":o.path):`/local/${i}`}),global.__vibeControlCodexState=void 0,',
    );
    extChanged = true;
  }

  const triggerNewChatTarget = 'triggerNewChatViaWebview(){this.sidebarView&&this.sidebarWebviewReady&&this.postMessageToWebview(this.sidebarView.webview,{type:"new-chat"})}';
  const queuedNewChatMarker = '__vibeControlQueueNewChat';
  const triggerNewChatPatched =
    `triggerNewChatViaWebview(){if(global.${prefillMarker}){this.sharedObjectRepository.set("composer_prefill",global.${prefillMarker}),this.broadcastToAllViews({type:"shared-object-updated",key:"composer_prefill",value:global.${prefillMarker}},void 0),global.${prefillMarker}=void 0}this.sidebarView&&this.sidebarWebviewReady&&this.postMessageToWebview(this.sidebarView.webview,{type:"new-chat"})}`;
  if (!content.includes(queuedNewChatMarker)) {
    const triggerNewChatReplacement =
      `triggerNewChatViaWebview(){if(global.${prefillMarker}){this.sharedObjectRepository.set("composer_prefill",global.${prefillMarker}),this.broadcastToAllViews({type:"shared-object-updated",key:"composer_prefill",value:global.${prefillMarker}},void 0),global.${prefillMarker}=void 0}this.sidebarView&&this.sidebarWebviewReady?this.postMessageToWebview(this.sidebarView.webview,{type:"new-chat"}):this.pendingSidebarMessages.push({type:"new-chat"});/*${queuedNewChatMarker}*/}`;
    if (content.includes(triggerNewChatPatched)) {
      content = content.replace(triggerNewChatPatched, triggerNewChatReplacement);
      extChanged = true;
    } else if (content.includes(triggerNewChatTarget)) {
      content = content.replace(triggerNewChatTarget, triggerNewChatReplacement);
      extChanged = true;
    }
  }

  const bufferedBroadcastMarker = '__vibeControlBufferedIpcBroadcasts';
  if (!content.includes(bufferedBroadcastMarker)) {
    const addBroadcastHandlerReplacement =
      'addBroadcastHandler(e,r){this.broadcastHandlers.set(e,r);let n=this.pendingBroadcastsByMethod?.get(e);return n&&(this.pendingBroadcastsByMethod.delete(e),n.forEach(o=>{Promise.resolve(r(o)).catch(i=>{this.logger.warning("Buffered broadcast handler failed",{safe:{method:e},sensitive:{error:i}})})})),()=>{this.broadcastHandlers.delete(e)}}/*__vibeControlBufferedIpcBroadcasts*/';
    const handleBroadcastReplacement =
      'async handleBroadcast(e){let r=this.broadcastHandlers.get(e.method);if(this.anyBroadcastHandlers.size>0&&await Promise.all(Array.from(this.anyBroadcastHandlers).map(n=>n(e))),r){await r(e);return}let n=this.pendingBroadcastsByMethod??(this.pendingBroadcastsByMethod=new Map),o=n.get(e.method);o?(o.push(e),o.length>25&&o.shift()):n.set(e.method,[e]),this.anyBroadcastHandlers.size===0&&this.logger.warning("Received broadcast but no handler is configured",{safe:{method:e.method},sensitive:{}})}';
    const nextContent = replaceAllLiteral(
      replaceAllLiteral(content, addBroadcastHandlerTarget, addBroadcastHandlerReplacement),
      handleBroadcastTarget,
      handleBroadcastReplacement,
    );
    if (nextContent !== content) {
      content = nextContent;
      extChanged = true;
    }
  }

  const followerResponseOriginMarker = '__vibeControlFollowerResponseOrigin';
  if (!content.includes(followerResponseOriginMarker)) {
    const nextContent = content.replace(
      originBoundFollowerResponsePattern,
      match => `${match.replace('if(!o||o.origin!==e)', 'if(!o)')}/*${followerResponseOriginMarker}*/`,
    );
    if (nextContent !== content) {
      content = nextContent;
      extChanged = true;
    }
  }

  if (
    !content.includes(openConversationCommandMarker)
    || !content.includes(requestSelectionCommandMarker)
    || !content.includes(autoApproveSweepCommandMarker)
  ) {
    const openConversationCommandReplacements: Array<[string, string]> = [
      [
        'e.push(it.commands.registerCommand("chatgpt.openSidebar",Uo)),',
        `e.push(it.commands.registerCommand("chatgpt.openSidebar",Uo)),`
          + `e.push(it.commands.registerCommand("chatgpt.openConversationById",async B=>{`
          + `if(typeof B!="string"||B.length===0)return;`
          + `let Le=await Ot.ensurePrimaryEditorPanel(),qe=Ot.getPanelViewColumn(Le)??it.ViewColumn.Active;`
          + `Le.reveal(qe),Ot.sendMessageToPanel(Le,{type:"navigate-to-route",path:\`/local/\${B}\`,state:void 0})`
          + `})),/*${openConversationCommandMarker}*/`
          + `e.push(it.commands.registerCommand("chatgpt.requestCurrentSelection",async()=>await Ot.requestCurrentSelectionFromActivePanel())),/*${requestSelectionCommandMarker}*/`
          + `e.push(it.commands.registerCommand("chatgpt.setVibeControlAutoApprovePermissions",async B=>{global.__vibeControlAutoApprovePermissions=!!B,Ot.broadcastToAllViews({type:"vibe-control-auto-approve-permissions",enabled:!!B})})),/*__vibeControlAutoApproveCommandV1*/`
          + `e.push(it.commands.registerCommand("chatgpt.approvePendingPermissionsInOpenViews",async()=>{await Ot.approvePendingPermissionsInOpenViews()})),/*${autoApproveSweepCommandMarker}*/`,
      ],
      [
        'e.push(ot.commands.registerCommand("chatgpt.openSidebar",Wo)),',
        `e.push(ot.commands.registerCommand("chatgpt.openSidebar",Wo)),`
          + `e.push(ot.commands.registerCommand("chatgpt.openConversationById",async B=>{`
          + `if(typeof B!="string"||B.length===0)return;`
          + `let Le=await ct.ensurePrimaryEditorPanel(),qe=ct.getPanelViewColumn(Le)??ot.ViewColumn.Active;`
          + `Le.reveal(qe),ct.sendMessageToPanel(Le,{type:"navigate-to-route",path:\`/local/\${B}\`,state:void 0})`
          + `})),/*${openConversationCommandMarker}*/`
          + `e.push(ot.commands.registerCommand("chatgpt.requestCurrentSelection",async()=>await ct.requestCurrentSelectionFromActivePanel())),/*${requestSelectionCommandMarker}*/`
          + `e.push(ot.commands.registerCommand("chatgpt.setVibeControlAutoApprovePermissions",async B=>{global.__vibeControlAutoApprovePermissions=!!B,ct.broadcastToAllViews({type:"vibe-control-auto-approve-permissions",enabled:!!B})})),/*__vibeControlAutoApproveCommandV1*/`
          + `e.push(ot.commands.registerCommand("chatgpt.approvePendingPermissionsInOpenViews",async()=>{await ct.approvePendingPermissionsInOpenViews()})),/*${autoApproveSweepCommandMarker}*/`,
      ],
    ];
    for (const [target, replacement] of openConversationCommandReplacements) {
      const nextContent = replaceAllLiteral(content, target, replacement);
      if (nextContent !== content) {
        content = nextContent;
        extChanged = true;
      }
    }
  }

  const requestSelectionMethodMarker = '__vibeControlCodexSelectionRequestMethodV1';
  const autoApproveSweepMethodMarker = '__vibeControlCodexAutoApproveSweepMethodV1';
  if (!content.includes(requestSelectionMethodMarker) || !content.includes(autoApproveSweepMethodMarker)) {
    const requestSelectionMethodTarget = 'sendMessageToPanel(e,r){let n=this.editorPanels.get(e);if(!n)return;let o=this.getWebviewForPanel(e);o&&(n.ready?this.postMessageToWebview(o,r):n.pendingMessages.push(r))}broadcastToPanels(e,r){';
    const requestSelectionMethodReplacement = 'sendMessageToPanel(e,r){let n=this.editorPanels.get(e);if(!n)return;let o=this.getWebviewForPanel(e);o&&(n.ready?this.postMessageToWebview(o,r):n.pendingMessages.push(r))}async requestCurrentSelectionFromActivePanel(){let e=this.focusedView?.kind==="panel"&&this.isPanelAlive(this.focusedView.panel)?this.focusedView.panel:this.getActivePanelFocusedView()?.kind==="panel"?this.getActivePanelFocusedView().panel:void 0;if(!e)return null;let r=`vibe-control-selection-${Date.now()}-${Math.random().toString(16).slice(2)}`,n=this.pendingVibeControlSelectionRequests??(this.pendingVibeControlSelectionRequests=new Map);return await new Promise(o=>{let i=setTimeout(()=>{n.delete(r),o(null)},1500);n.set(r,{resolve:o,timeout:i});this.sendMessageToPanel(e,{type:"vibe-control-request-selection",requestId:r})})}/*__vibeControlCodexSelectionRequestMethodV1*/async approvePendingPermissionsInOpenViews(){for(let[e,r]of Array.from(this.editorPanels.entries())){let n=r?.initialRoute,o=typeof n==="string"?decodeURIComponent((n.match(/\\/local\\/([^/?#]+)/)||[])[1]||""):"";o&&this.sendMessageToPanel(e,{type:"vibe-control-approve-pending-permissions",conversationId:o})}}/*__vibeControlCodexAutoApproveSweepMethodV1*/broadcastToPanels(e,r){';
    if (content.includes(requestSelectionMethodTarget)) {
      content = content.replace(requestSelectionMethodTarget, requestSelectionMethodReplacement);
      extChanged = true;
    }
  }

  const selectionHostMarker = '__vibeControlCodexSelectionHostV7';
  if (!content.includes(selectionHostMarker)) {
    const selectionHostTarget = 'case"ready":break;case"persisted-atom-sync-request":{';
    const selectionHostReplacement = 'case"ready":break;case"vibe-control-selection-response":{let a=r.payload&&typeof r.payload==="object"?r.payload:r,n=typeof a.requestId==="string"?a.requestId:"",o=this.findPanelByWebview(e),i=o?this.editorPanels.get(o):void 0,s=typeof a.route==="string"&&/\\/local\\/[^/?#]+/.test(a.route)?a.route:i?.initialRoute,c=typeof s==="string"?decodeURIComponent((s.match(/\\/local\\/([^/?#]+)/)||[])[1]||""):void 0,u=this.pendingVibeControlSelectionRequests?.get(n);u&&(this.pendingVibeControlSelectionRequests.delete(n),clearTimeout(u.timeout),u.resolve(typeof a.text==="string"&&a.text.trim().length>0?{provider:"codex",sessionId:c||void 0,route:typeof s==="string"?s:void 0,text:a.text,title:typeof a.title==="string"?a.title:void 0}:null));break}case"vibe-control-selection-updated":{let a=r.payload&&typeof r.payload==="object"?r.payload:r,n=this.findPanelByWebview(e),o=n?this.editorPanels.get(n):void 0,i=typeof a.route==="string"&&/\\/local\\/[^/?#]+/.test(a.route)?a.route:o?.initialRoute,s=typeof i==="string"?decodeURIComponent((i.match(/\\/local\\/([^/?#]+)/)||[])[1]||""):void 0;await ke.commands.executeCommand("vibe-control.updateWebviewSelectionPayload",typeof a.text==="string"?{provider:"codex",sessionId:s||void 0,route:typeof i==="string"?i:void 0,text:a.text,title:typeof a.title==="string"?a.title:void 0}:null);break}case"vibe-control-selection-to-note":{let a=r.payload&&typeof r.payload==="object"?r.payload:r,n=this.findPanelByWebview(e),o=n?this.editorPanels.get(n):void 0,i=typeof a.route==="string"&&/\\/local\\/[^/?#]+/.test(a.route)?a.route:o?.initialRoute,s=typeof i==="string"?decodeURIComponent((i.match(/\\/local\\/([^/?#]+)/)||[])[1]||""):void 0;await ke.commands.executeCommand("vibe-control.addSelectionToNoteFromWebviewPayload",{provider:"codex",sessionId:s||void 0,route:typeof i==="string"?i:void 0,text:typeof a.text==="string"?a.text:"",title:typeof a.title==="string"?a.title:void 0});break}/*__vibeControlCodexSelectionHostV7*/case"persisted-atom-sync-request":{';
    if (content.includes(selectionHostTarget)) {
      content = content.replace(selectionHostTarget, selectionHostReplacement);
      extChanged = true;
    }
  }

  const workingStateHostMarker = '__vibeControlCodexWorkingStateHostV1';
  if (!content.includes(workingStateHostMarker)) {
    const workingStateHostTarget =
      'case"thread-stream-state-changed":{let n=this.getIpcClientForWebview(e);if(!n)throw new Error("Missing IPC client for webview");await n.sendBroadcast("thread-stream-state-changed",r);break}case"thread-read-state-changed":{let n=this.getIpcClientForWebview(e);if(!n)throw new Error("Missing IPC client for webview");await n.sendBroadcast("thread-read-state-changed",{conversationId:r.conversationId,hasUnreadTurn:r.hasUnreadTurn});break}';
    const workingStateHostReplacement =
      'case"thread-stream-state-changed":{let n=this.getIpcClientForWebview(e);if(!n)throw new Error("Missing IPC client for webview");await n.sendBroadcast("thread-stream-state-changed",r),Te.commands.executeCommand("vibe-control.updateProviderSessionWorkingState",{provider:"codex",sessionId:typeof r.conversationId==="string"?r.conversationId:void 0,raw:r});break}case"thread-read-state-changed":{let n=this.getIpcClientForWebview(e);if(!n)throw new Error("Missing IPC client for webview");let o={conversationId:r.conversationId,hasUnreadTurn:r.hasUnreadTurn};await n.sendBroadcast("thread-read-state-changed",o),Te.commands.executeCommand("vibe-control.updateProviderSessionWorkingState",{provider:"codex",sessionId:typeof r.conversationId==="string"?r.conversationId:void 0,raw:o});break}/*__vibeControlCodexWorkingStateHostV1*/';
    if (content.includes(workingStateHostTarget)) {
      content = content.replace(workingStateHostTarget, workingStateHostReplacement);
      extChanged = true;
    }
  }

  const extJsCriticalChecks: string[] = [];
  if (content.includes(addBroadcastHandlerTarget) || content.includes(handleBroadcastTarget)) {
    extJsCriticalChecks.push('IPC broadcast buffering patch');
  }
  if (originBoundFollowerResponsePattern.test(content)) {
    extJsCriticalChecks.push('follower response origin patch');
  }
  if (!content.includes(openConversationCommandMarker)) {
    extJsCriticalChecks.push('open conversation command patch');
  }
  if (!content.includes(requestSelectionCommandMarker)) {
    extJsCriticalChecks.push('request selection command patch');
  }
  if (!content.includes(autoApproveSweepCommandMarker)) {
    extJsCriticalChecks.push('auto approve sweep command patch');
  }
  if (!content.includes(requestSelectionMethodMarker)) {
    extJsCriticalChecks.push('request selection method patch');
  }
  if (!content.includes(autoApproveSweepMethodMarker)) {
    extJsCriticalChecks.push('auto approve sweep method patch');
  }
  if (!content.includes(selectionHostMarker)) {
    extJsCriticalChecks.push('selection host patch');
  }
  if (!content.includes(workingStateHostMarker)) {
    extJsCriticalChecks.push('working state host patch');
  }
  if (extJsCriticalChecks.length > 0) {
    reports.push(summarizePatchState('extension-host', 'anchor_missing'));
    warnings.push(`Codex extension host patch verification failed for out/extension.js: ${extJsCriticalChecks.join(', ')}`);
  } else if (extChanged) {
    reports.push(summarizePatchState('extension-host', 'applied'));
    overallChanged = true;
    pendingWrites.push({ path: extJsPath, content });
  } else {
    reports.push(summarizePatchState('extension-host', 'already_present'));
  }

  const assetsDir = path.join(extensionPath, 'webview', 'assets');
  const assetFiles = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  const webviewSelection = selectBundle(assetFiles, /^index-.*\.js$/, 'webview-bundle');
  if (webviewSelection.warning) {
    warnings.push(`Codex patch verification warning for ${extensionPath}: ${webviewSelection.warning}`);
  }
  const webviewBundle = webviewSelection.selected;
  if (!webviewBundle) {
    reports.push(summarizePatchState('webview', 'missing_file'));
    warnings.push(`Codex patch verification failed for ${extensionPath}: no webview bundle matched index-*.js`);
  }
  if (webviewBundle) {
    const webviewPath = path.join(assetsDir, webviewBundle);
    const originalWebviewContent = fs.readFileSync(webviewPath, 'utf-8');
    let webviewContent = stripLegacySelectionNoteBridgeScripts(originalWebviewContent);
    let webviewChanged = webviewContent !== originalWebviewContent;

    const autoSubmitMarker = '__vibeControlAutoSubmit';
    if (!webviewContent.includes(autoSubmitMarker)) {
      const prefillTarget = 'let[gr,_r]=kn(`composer_prefill`),vr=(0,Z.useEffectEvent)(()=>{gr?.text&&k==null&&(gr.cwd==null?Ut(null):Ut(gr.cwd),ZV(gr.text)?(Yt.setPromptText(gr.text),Yt.syncMentionMetadata({skills:di,apps:ui,plugins:fi})):Yt.setText(gr.text),Yt.focus(),_r(void 0))});';
      const prefillReplacement = 'let[gr,_r]=kn(`composer_prefill`),vr=(0,Z.useEffectEvent)(()=>{gr?.text&&k==null&&(gr.cwd==null?Ut(null):Ut(gr.cwd),ZV(gr.text)?(Yt.setPromptText(gr.text),Yt.syncMentionMetadata({skills:di,apps:ui,plugins:fi})):Yt.setText(gr.text),Yt.focus(),gr.autoSubmit&&requestAnimationFrame(()=>{let e=new KeyboardEvent(\"keydown\",{key:\"Enter\",bubbles:!0,cancelable:!0});Yt.view.dom.dispatchEvent(e)}),_r(void 0))});/*__vibeControlAutoSubmit*/';
      const prefillTargetCurrent = 'let[wr,Tr]=ct(`composer_prefill`),Er=(0,Z.useEffectEvent)(()=>{wr?.text&&F==null&&(wr.cwd==null?Xt(null):Xt(wr.cwd),iK(wr.text)?(tn.setPromptText(wr.text),tn.syncMentionMetadata({skills:wi,apps:Si,plugins:Ti})):tn.setText(wr.text),tn.focus(),Tr(void 0))});';
      const prefillReplacementCurrent = 'let[wr,Tr]=ct(`composer_prefill`),Er=(0,Z.useEffectEvent)(()=>{wr?.text&&F==null&&(wr.cwd==null?Xt(null):Xt(wr.cwd),iK(wr.text)?(tn.setPromptText(wr.text),tn.syncMentionMetadata({skills:wi,apps:Si,plugins:Ti})):tn.setText(wr.text),tn.focus(),wr.autoSubmit&&requestAnimationFrame(()=>{let e=new KeyboardEvent(\"keydown\",{key:\"Enter\",bubbles:!0,cancelable:!0});tn.view.dom.dispatchEvent(e)}),Tr(void 0))});/*__vibeControlAutoSubmit*/';
      if (webviewContent.includes(prefillTarget)) {
        webviewContent = webviewContent.replace(prefillTarget, prefillReplacement);
        webviewChanged = true;
      } else if (webviewContent.includes(prefillTargetCurrent)) {
        webviewContent = webviewContent.replace(prefillTargetCurrent, prefillReplacementCurrent);
        webviewChanged = true;
      }
    }

    const followerResumeMarker = '__vibeControlResumeFollower';
    if (!webviewContent.includes(followerResumeMarker)) {
      const followerResumeReplacements: Array<[string, string]> = [
        [
          'e.needsResume(n)&&await Cn(e,{conversationId:n,model:null,reasoningEffort:null,workspaceRoots:t.workspaceRoots?.roots??[r],collaborationMode:t.collaborationMode??a});',
          '(e.needsResume(n)||e.getStreamRole(n)?.role===`follower`)&&await Cn(e,{conversationId:n,model:null,reasoningEffort:null,workspaceRoots:t.workspaceRoots?.roots??[r],collaborationMode:t.collaborationMode??a});/*__vibeControlResumeFollower*/',
        ],
        [
          'I.needsResume(e)&&await Cn(I,{conversationId:e,model:null,reasoningEffort:null,workspaceRoots:i.workspaceRoots?.roots??[Zt],collaborationMode:i.collaborationMode??t});',
          '(I.needsResume(e)||I.getStreamRole(e)?.role===`follower`)&&await Cn(I,{conversationId:e,model:null,reasoningEffort:null,workspaceRoots:i.workspaceRoots?.roots??[Zt],collaborationMode:i.collaborationMode??t});/*__vibeControlResumeFollower*/',
        ],
        [
          'a.needsResume(t)&&await Cn(a,{conversationId:t,model:null,reasoningEffort:null,workspaceRoots:r,collaborationMode:null}),',
          '(a.needsResume(t)||a.getStreamRole(t)?.role===`follower`)&&await Cn(a,{conversationId:t,model:null,reasoningEffort:null,workspaceRoots:r,collaborationMode:null})/*__vibeControlResumeFollower*/,',
        ],
      ];
      for (const [target, replacement] of followerResumeReplacements) {
        const nextContent = replaceAllLiteral(webviewContent, target, replacement);
        if (nextContent !== webviewContent) {
          webviewContent = nextContent;
          webviewChanged = true;
        }
      }
    }

    const tabHydrationMarker = '__vibeControlTabHydration';
    if (!webviewContent.includes(tabHydrationMarker)) {
      const tabHydrationReplacements: Array<[string, string]> = [
        [
          '()=>e==null?null:t.getMaybeForConversationId(e)',
          '()=>e==null?null:t.getMaybeForConversationId(e)??t.getDefault()/*__vibeControlTabHydration*/',
        ],
        [
          'a?ne&&!re?(0,$.jsx)(kc,{fillParent:!0,debugName:`LocalConversationThread.subagentTurns`}):!ne&&t&&!re?(0,$.jsx)(kc,{fillParent:!0,debugName:`LocalConversationThread.resume`}):(0,$.jsxs)($.Fragment,{children:[',
          'a?ne&&!re?(0,$.jsx)(kc,{fillParent:!0,debugName:`LocalConversationThread.subagentTurns`}):!ne&&(t||u!==`resumed`)&&!re?(0,$.jsx)(kc,{fillParent:!0,debugName:`LocalConversationThread.resume`}):(0,$.jsxs)($.Fragment,{children:[/*__vibeControlTabHydration*/',
        ],
      ];
      for (const [target, replacement] of tabHydrationReplacements) {
        const nextContent = replaceAllLiteral(webviewContent, target, replacement);
        if (nextContent !== webviewContent) {
          webviewContent = nextContent;
          webviewChanged = true;
        }
      }
    }

    const selectionMainHandlerMarker = '__vibeControlSelectionMainHandlerV1';
    if (!webviewContent.includes(selectionMainHandlerMarker)) {
      const selectionMainHandlerTarget =
        'case`fetch-stream-event`:case`fetch-stream-error`:case`fetch-stream-complete`:break bb3;case`shared-object-updated`:break bb3;';
      const selectionMainHandlerReplacement =
        'case`fetch-stream-event`:case`fetch-stream-error`:case`fetch-stream-complete`:break bb3;case`vibe-control-request-selection`:{let t=(()=>{let t=e=>{let t=String(e??``).replace(/\\s+/g,` `).trim();return t.length>12e3?t.slice(0,12e3):t},r=e=>{if(!e||e.rangeCount===0||e.isCollapsed)return``;try{let r=t(e.toString());if(r)return r}catch{}try{let r=``;for(let n=0;n<e.rangeCount;n+=1){let o=e.getRangeAt(n).cloneContents(),i=t(o.textContent||``);i&&(r+=(r?`\\n\\n`:``)+i)}return t(r)}catch{return``}},n=``,o=e=>{e.length>n.length&&(n=e)},i=[];document.documentElement&&i.push(document.documentElement);let a=new WeakSet;o(r(window.getSelection?window.getSelection():null)),o(r(document.getSelection?document.getSelection():null));for(;i.length>0;){let e=i.pop();if(!(e instanceof Element))continue;let t=e.shadowRoot;t&&!a.has(t)&&(a.add(t),o(r(typeof t.getSelection==`function`?t.getSelection():null)),Array.from(t.children).forEach(e=>i.push(e))),Array.from(e.children).forEach(e=>i.push(e))}return t(n)})();E.dispatchMessage(`log-message`,{level:`info`,message:`Vibe Control Selection MainHandler: request requestId=${typeof e.requestId===`string`?e.requestId:``} length=${t.length}`}),E.dispatchMessage(`vibe-control-selection-response`,{provider:`codex`,requestId:typeof e.requestId===`string`?e.requestId:``,text:t,route:String((window.location?.pathname||``)+(window.location?.hash||``)),title:document.title||``});break bb3}/*__vibeControlSelectionMainHandlerV1*/case`shared-object-updated`:break bb3;';
      if (webviewContent.includes(selectionMainHandlerTarget)) {
        webviewContent = webviewContent.replace(selectionMainHandlerTarget, selectionMainHandlerReplacement);
        webviewChanged = true;
      }
    }

    const approvePendingRequestsMarker = '__vibeControlApprovePendingRequestsV2';
    const approvePendingRequestsTarget = 'case`navigate-to-route`:break bb3;';
    const legacyApprovePendingRequestsReplacement =
      'case`vibe-control-approve-pending-permissions`:{let t=i.getForHostIdOrThrowWhenDefaultHost(e.hostId),n=e.conversationId??null,o=n!=null&&Ar(r,n)===t;if(n!=null&&o)for(let e of B(r,hr,n)??[])e.method===`item/commandExecution/requestApproval`?await vl(`reply-with-command-execution-approval-decision`,{conversationId:n,requestId:e.id,decision:`acceptForSession`}):e.method===`item/fileChange/requestApproval`&&await vl(`reply-with-file-change-approval-decision`,{conversationId:n,requestId:e.id,decision:`acceptForSession`});break bb3}/*__vibeControlApprovePendingRequestsV1*/case`navigate-to-route`:break bb3;';
    const approvePendingRequestsReplacement =
      'case`vibe-control-approve-pending-permissions`:{let t=i.getForHostIdOrThrowWhenDefaultHost(e.hostId),n=e.conversationId??null,o=n!=null&&Ar(r,n)===t;if(n!=null&&o){let e=t=>{let n=(t?.options??[]).map(e=>typeof e?.label===`string`?e.label.trim():``).filter(Boolean),o=n.map(e=>({label:e,normalized:e.toLowerCase().replace(/[\\\'\\u2019]/g,``)})),r=o.find(e=>/dont ask again|always allow|allow for this chat|allow this host for this conversation|dont ask again this session|dont ask again for commands/.test(e.normalized));if(r)return r.label;let i=o.find(e=>/^(yes|allow|accept|continue)$/.test(e.normalized)||/^yes\\b/.test(e.normalized)||/^allow\\b/.test(e.normalized)||/^accept\\b/.test(e.normalized)||/^continue\\b/.test(e.normalized));return i?.label??o.find(e=>!/\\b(no|not now|deny|decline|cancel|skip)\\b/.test(e.normalized))?.label??n[0]??``},t=async t=>{let o={};for(let r of t?.params?.questions??[]){let t=e(r);t&&(o[r.id]={answers:[t]})}Object.keys(o).length>0&&await vl(`reply-with-user-input-response`,{conversationId:n,requestId:t.id,response:{answers:o}})},o=async e=>{await vl(`reply-with-mcp-server-elicitation-response`,{conversationId:n,requestId:e.id,response:{action:`accept`}})};for(let e of B(r,hr,n)??[])e.method===`item/commandExecution/requestApproval`?await vl(`reply-with-command-execution-approval-decision`,{conversationId:n,requestId:e.id,decision:`acceptForSession`}):e.method===`item/fileChange/requestApproval`?await vl(`reply-with-file-change-approval-decision`,{conversationId:n,requestId:e.id,decision:`acceptForSession`}):e.method===`item/tool/requestUserInput`?await t(e):e.method===`mcpServer/elicitation/request`&&await o(e)}break bb3}/*__vibeControlApprovePendingRequestsV2*/case`navigate-to-route`:break bb3;';
    if (webviewContent.includes(legacyApprovePendingRequestsReplacement)) {
      webviewContent = webviewContent.replace(
        legacyApprovePendingRequestsReplacement,
        approvePendingRequestsReplacement,
      );
      webviewChanged = true;
    }
    if (!webviewContent.includes(approvePendingRequestsMarker)) {
      if (webviewContent.includes(approvePendingRequestsTarget)) {
        webviewContent = webviewContent.replace(approvePendingRequestsTarget, approvePendingRequestsReplacement);
        webviewChanged = true;
      }
    }


    const selectionBridgeMarker = '__vibeControlCodexSelectionBridgeV8';
    if (!webviewContent.includes(selectionBridgeMarker)) {
      webviewContent += `
;${buildWebviewSelectionNoteBridgeScript('codex')}/*${selectionBridgeMarker}*/
`;
      webviewChanged = true;
    }

    const webviewCriticalChecks = collectMissingChecks(webviewContent, [
      { needle: followerResumeMarker, label: 'follower resume patch' },
      { needle: tabHydrationMarker, label: 'tab hydration patch' },
      { needle: selectionMainHandlerMarker, label: 'selection main-handler patch' },
      { needle: approvePendingRequestsMarker, label: 'approve pending requests patch' },
      { needle: selectionBridgeMarker, label: 'selection bridge patch' },
    ]);
    if (webviewCriticalChecks.length > 0) {
      reports.push(summarizePatchState('webview', 'anchor_missing'));
      warnings.push(`Codex webview patch verification failed for ${webviewBundle}: ${webviewCriticalChecks.join(', ')}`);
    } else if (webviewChanged) {
      reports.push(summarizePatchState('webview', 'applied'));
      overallChanged = true;
      pendingWrites.push({ path: webviewPath, content: webviewContent });
    } else {
      reports.push(summarizePatchState('webview', 'already_present'));
    }
  }

  const hooksSelection = selectBundle(assetFiles, /^app-server-manager-hooks-.*\.js$/, 'hooks-bundle');
  if (hooksSelection.warning) {
    warnings.push(`Codex patch verification warning for ${extensionPath}: ${hooksSelection.warning}`);
  }
  const appServerHooksBundle = hooksSelection.selected;
  if (!appServerHooksBundle) {
    reports.push(summarizePatchState('hooks', 'missing_file'));
    warnings.push(`Codex patch verification failed for ${extensionPath}: no hooks bundle matched app-server-manager-hooks-*.js`);
  }
  if (appServerHooksBundle) {
    const hooksPath = path.join(assetsDir, appServerHooksBundle);
    let hooksContent = fs.readFileSync(hooksPath, 'utf-8');
    let hooksChanged = false;

    const followerFallbackReplacements: Array<[string, string]> = [
      [
        'async sendThreadFollowerRequest(e,t,n){if(e?.role!==`follower`)return null;let r=await gr(t,n,{targetClientId:e.ownerClientId});if(r.resultType===`error`)throw Error(r.error);return r.result}',
        'async sendThreadFollowerRequest(e,t,n){if(e?.role!==`follower`)return null;let r=await gr(t,n,{targetClientId:e.ownerClientId});if(r.resultType===`error`){let a=r.error??`unknown-error`;if(a===`no-client-found`||a===`client-not-found`||a===`client-disconnected`||a===`timeout`||a===`request-timeout`||a===`Please continue this conversation on the window where it was started.`)return n?.conversationId!=null&&(this.markConversationStreaming(n.conversationId),this.setConversationStreamRole(n.conversationId,{role:`owner`})),i.warning(`Thread follower request fell back to local handling`,{safe:{method:t,conversationId:n?.conversationId??Fh(n)??`unknown`,reason:a},sensitive:{ownerClientId:e.ownerClientId}}),null;throw Error(a)}return r.result}/*__vibeControlFollowerFallback*//*__vibeControlFollowerOwnerFallback*/',
      ],
      [
        'async sendThreadFollowerRequest(e,t,n){if(e?.role!==`follower`)return null;let r=await gr(t,n,{targetClientId:e.ownerClientId});if(r.resultType===`error`){if((r.error===`no-client-found`||r.error===`client-not-found`||r.error===`client-disconnected`)&&n.conversationId!=null)return i.warning(`thread_follower_owner_missing_recovering`,{safe:{conversationId:n.conversationId,method:t},sensitive:{error:r.error}}),this.markConversationStreaming(n.conversationId),this.setConversationStreamRole(n.conversationId,{role:`owner`}),null;throw Error(r.error)}return r.result}/*__vibeControlRecoverFollowerOwner*/',
        'async sendThreadFollowerRequest(e,t,n){if(e?.role!==`follower`)return null;let r=await gr(t,n,{targetClientId:e.ownerClientId});if(r.resultType===`error`){let a=r.error??`unknown-error`;if(a===`no-client-found`||a===`client-not-found`||a===`client-disconnected`||a===`timeout`||a===`request-timeout`||a===`Please continue this conversation on the window where it was started.`)return n?.conversationId!=null&&(this.markConversationStreaming(n.conversationId),this.setConversationStreamRole(n.conversationId,{role:`owner`})),i.warning(`Thread follower request fell back to local handling`,{safe:{method:t,conversationId:n?.conversationId??Fh(n)??`unknown`,reason:a},sensitive:{ownerClientId:e.ownerClientId}}),null;throw Error(a)}return r.result}/*__vibeControlFollowerFallback*//*__vibeControlFollowerOwnerFallback*/',
      ],
      [
        'async sendThreadFollowerRequest(e,t,n){if(e?.role!==`follower`)return null;let r=await gr(t,n,{targetClientId:e.ownerClientId});if(r.resultType===`error`){let a=r.error??`unknown-error`;if(a===`no-client-found`||a===`client-not-found`||a===`client-disconnected`||a===`timeout`||a===`request-timeout`)return n?.conversationId!=null&&(this.markConversationStreaming(n.conversationId),this.setConversationStreamRole(n.conversationId,{role:`owner`})),i.warning(`Thread follower request fell back to local handling`,{safe:{method:t,conversationId:n?.conversationId??Fh(n)??`unknown`,reason:a},sensitive:{ownerClientId:e.ownerClientId}}),null;throw Error(a)}return r.result}/*__vibeControlFollowerFallback*//*__vibeControlFollowerOwnerFallback*/',
        'async sendThreadFollowerRequest(e,t,n){if(e?.role!==`follower`)return null;let r=await gr(t,n,{targetClientId:e.ownerClientId});if(r.resultType===`error`){let a=r.error??`unknown-error`;if(a===`no-client-found`||a===`client-not-found`||a===`client-disconnected`||a===`timeout`||a===`request-timeout`||a===`Please continue this conversation on the window where it was started.`)return n?.conversationId!=null&&(this.markConversationStreaming(n.conversationId),this.setConversationStreamRole(n.conversationId,{role:`owner`})),i.warning(`Thread follower request fell back to local handling`,{safe:{method:t,conversationId:n?.conversationId??Fh(n)??`unknown`,reason:a},sensitive:{ownerClientId:e.ownerClientId}}),null;throw Error(a)}return r.result}/*__vibeControlFollowerFallback*//*__vibeControlFollowerOwnerFallback*/',
      ],
      [
        'async sendThreadFollowerRequest(e,t,n){if(e?.role!==`follower`)return null;let r=await gr(t,n,{targetClientId:e.ownerClientId});if(r.resultType===`error`){let a=r.error??`unknown-error`;if(a===`no-client-found`||a===`client-disconnected`||a===`timeout`||a===`request-timeout`)return i.warning(`Thread follower request fell back to local handling`,{safe:{method:t,conversationId:n?.conversationId??Fh(n)??`unknown`,reason:a},sensitive:{ownerClientId:e.ownerClientId}}),null;throw Error(a)}return r.result}/*__vibeControlFollowerFallback*/',
        'async sendThreadFollowerRequest(e,t,n){if(e?.role!==`follower`)return null;let r=await gr(t,n,{targetClientId:e.ownerClientId});if(r.resultType===`error`){let a=r.error??`unknown-error`;if(a===`no-client-found`||a===`client-not-found`||a===`client-disconnected`||a===`timeout`||a===`request-timeout`||a===`Please continue this conversation on the window where it was started.`)return n?.conversationId!=null&&(this.markConversationStreaming(n.conversationId),this.setConversationStreamRole(n.conversationId,{role:`owner`})),i.warning(`Thread follower request fell back to local handling`,{safe:{method:t,conversationId:n?.conversationId??Fh(n)??`unknown`,reason:a},sensitive:{ownerClientId:e.ownerClientId}}),null;throw Error(a)}return r.result}/*__vibeControlFollowerFallback*//*__vibeControlFollowerOwnerFallback*/',
      ],
      [
        'let l=e.getConversation(t),u=e.getStreamRole(t)?.role!==`owner`;/*__vibeControlRecoverFollowerOwner*/',
        'let l=e.getConversation(t),u=e.getStreamRole(t)==null;',
      ],
      [
        'if(a)return a.result;r=e.getStreamRole(t);if(r?.role!==`owner`)throw Error(mo);/*__vibeControlRecoverFollowerOwner*/',
        'if(a)return a.result;r=e.getStreamRole(t);if(r?.role!==`owner`)throw Error(mo);/*__vibeControlFollowerOwnerFallback*/',
      ],
      [
        'if(a)return a.result;if(r?.role!==`owner`)throw Error(mo);',
        'if(a)return a.result;r=e.getStreamRole(t);if(r?.role!==`owner`)throw Error(mo);/*__vibeControlFollowerOwnerFallback*/',
      ],
      [
        'if(await e.sendThreadFollowerRequest(a,`thread-follower-edit-last-user-turn`,{conversationId:t,turnId:n.turnId,message:r,agentMode:i}))return;a=e.getStreamRole(t);if(a?.role!==`owner`)throw Error(mo);/*__vibeControlRecoverFollowerOwner*/',
        'if(await e.sendThreadFollowerRequest(a,`thread-follower-edit-last-user-turn`,{conversationId:t,turnId:n.turnId,message:r,agentMode:i}))return;a=e.getStreamRole(t);if(a?.role!==`owner`)throw Error(mo);/*__vibeControlFollowerOwnerFallback*/',
      ],
      [
        'if(await e.sendThreadFollowerRequest(a,`thread-follower-edit-last-user-turn`,{conversationId:t,turnId:n.turnId,message:r,agentMode:i}))return;if(a?.role!==`owner`)throw Error(mo);',
        'if(await e.sendThreadFollowerRequest(a,`thread-follower-edit-last-user-turn`,{conversationId:t,turnId:n.turnId,message:r,agentMode:i}))return;a=e.getStreamRole(t);if(a?.role!==`owner`)throw Error(mo);/*__vibeControlFollowerOwnerFallback*/',
      ],
    ];
    for (const [target, replacement] of followerFallbackReplacements) {
      const nextContent = replaceAllLiteral(hooksContent, target, replacement);
      if (nextContent !== hooksContent) {
        hooksContent = nextContent;
        hooksChanged = true;
      }
    }

    const requestLookup =
      'let r=e.conversations.get(t);return r?r.requests.find(e=>e.id===n&&!kr(e))||(i.error(`Request not found`,{safe:{requestId:n},sensitive:{}}),null):(i.error(`Conversation state not found`,{safe:{conversationId:t},sensitive:{}}),null)';
    const requestScopeReplacements: Array<[string, string]> = [
      [
        `getConversationRequest:(t,n)=>{${requestLookup}},removeConversationRequest:(t,n)=>{e.updateConversationState(t,e=>{e.requests=e.requests.filter(e=>e.id!==n)})},`,
        `getConversationRequest:(t,n)=>{if(e.getStreamRole(t)?.role===\`follower\`)throw Error(mo);${requestLookup}},getLocalConversationRequest:(t,n)=>{${requestLookup}},removeConversationRequest:(t,n)=>{e.updateConversationState(t,e=>{e.requests=e.requests.filter(e=>e.id!==n)})},`,
      ],
      [
        `getConversationRequest:(t,n)=>{if(e.getStreamRole(t)?.role===\`follower\`)throw Error(\`Please continue this conversation on the window where it was started.\`);${requestLookup}},removeConversationRequest:(t,n)=>{e.updateConversationState(t,e=>{e.requests=e.requests.filter(e=>e.id!==n)})},`,
        `getConversationRequest:(t,n)=>{if(e.getStreamRole(t)?.role===\`follower\`)throw Error(mo);${requestLookup}},getLocalConversationRequest:(t,n)=>{${requestLookup}},removeConversationRequest:(t,n)=>{e.updateConversationState(t,e=>{e.requests=e.requests.filter(e=>e.id!==n)})},`,
      ],
      [
        'function co(e,t,n,r,o){let s=e.getConversationRequest(t,n);if(!s)return;if(s.method!==r){i.error(`Unexpected approval request method`,{safe:{method:s.method},sensitive:{}});return}let c;switch(r){case`item/commandExecution/requestApproval`:c={id:n,result:{decision:o}};break;case`item/fileChange/requestApproval`:c={id:n,result:{decision:o}};break}i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:s.method,response:c.result}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:c}),e.removeConversationRequest(t,n)}',
        'function co(e,t,n,r,o){let s=e.getLocalConversationRequest(t,n);if(!s)return;if(s.method!==r){i.error(`Unexpected approval request method`,{safe:{method:s.method},sensitive:{}});return}let c;switch(r){case`item/commandExecution/requestApproval`:c={id:n,result:{decision:o}};break;case`item/fileChange/requestApproval`:c={id:n,result:{decision:o}};break}i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:s.method,response:c.result}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:c}),e.removeConversationRequest(t,n)}',
      ],
    ];
    for (const [target, replacement] of requestScopeReplacements) {
      const nextContent = replaceAllLiteral(hooksContent, target, replacement);
      if (nextContent !== hooksContent) {
        hooksContent = nextContent;
        hooksChanged = true;
      }
    }

    const followerFallbackHardeningReplacements: Array<[string, string]> = [
      [
        'async sendThreadFollowerRequest(e,t,n){if(e?.role!==`follower`)return null;let r=await gr(t,n,{targetClientId:e.ownerClientId});if(r.resultType===`error`){let a=r.error??`unknown-error`;if(a===`no-client-found`||a===`client-not-found`||a===`client-disconnected`||a===`timeout`||a===`request-timeout`||a===`Please continue this conversation on the window where it was started.`)return n?.conversationId!=null&&(this.markConversationStreaming(n.conversationId),this.setConversationStreamRole(n.conversationId,{role:`owner`})),i.warning(`Thread follower request fell back to local handling`,{safe:{method:t,conversationId:n?.conversationId??Fh(n)??`unknown`,reason:a},sensitive:{ownerClientId:e.ownerClientId}}),null;throw Error(a)}return r.result}/*__vibeControlFollowerFallback*//*__vibeControlFollowerOwnerFallback*/',
        'async sendThreadFollowerRequest(e,t,n){if(e?.role!==`follower`)return null;for(let r=0;;r++){let a=await gr(t,n,{targetClientId:e.ownerClientId});if(a.resultType!==`error`)return a.result;let o=a.error??`unknown-error`,s=String(o);if(s.includes(`no-client-found`)||s.includes(`client-not-found`)||s.includes(`client-disconnected`)||s.includes(`Please continue this conversation on the window where it was started.`))return n?.conversationId!=null&&(this.markConversationStreaming(n.conversationId),this.setConversationStreamRole(n.conversationId,{role:`owner`})),i.warning(`Thread follower request fell back to local handling`,{safe:{method:t,conversationId:n?.conversationId??Fh(n)??`unknown`,reason:s},sensitive:{ownerClientId:e.ownerClientId}}),null;if((s.includes(`Server overloaded`)||s.includes(`retry later`))&&r<1){await new Promise(e=>setTimeout(e,500));continue}throw Error(o)}}/*__vibeControlFollowerFallback*//*__vibeControlFollowerOwnerFallback*/',
      ],
    ];
    for (const [target, replacement] of followerFallbackHardeningReplacements) {
      const nextContent = replaceAllLiteral(hooksContent, target, replacement);
      if (nextContent !== hooksContent) {
        hooksContent = nextContent;
        hooksChanged = true;
      }
    }

    const approvalFallbackReplacements: Array<[string, string]> = [
      [
        'getConversationRequest:(t,n)=>{if(e.getStreamRole(t)?.role===`follower`)throw Error(`Please continue this conversation on the window where it was started.`);let r=e.conversations.get(t);return',
        'getConversationRequest:(t,n)=>{let r=e.conversations.get(t);return',
      ],
      [
        'function lo(e,t,n,r){let a=oo(e,t);if(a){so(a,`thread-follower-command-approval-decision`,{conversationId:t,requestId:n,decision:r}).catch(a=>{if(String(a).includes(`no-client-found`)||String(a).includes(`client-not-found`)||String(a).includes(`client-disconnected`)||String(a).includes(`timeout`)||String(a).includes(`request-timeout`)){co(e,t,n,`item/commandExecution/requestApproval`,r);return}i.error(`Failed to forward command approval decision`,{safe:{conversationId:t},sensitive:{error:a}})});return}co(e,t,n,`item/commandExecution/requestApproval`,r)}/*__vibeControlApprovalFallback*/',
        'function lo(e,t,n,r){let a=oo(e,t);if(a){so(a,`thread-follower-command-approval-decision`,{conversationId:t,requestId:n,decision:r}).catch(a=>{if(String(a).includes(`no-client-found`)||String(a).includes(`client-not-found`)||String(a).includes(`client-disconnected`)||String(a).includes(`timeout`)||String(a).includes(`request-timeout`)||String(a).includes(`Please continue this conversation on the window where it was started.`)){co(e,t,n,`item/commandExecution/requestApproval`,r);return}i.error(`Failed to forward command approval decision`,{safe:{conversationId:t},sensitive:{error:a}})});return}co(e,t,n,`item/commandExecution/requestApproval`,r)}/*__vibeControlApprovalFallback*/',
      ],
      [
        'function lo(e,t,n,r){let a=oo(e,t);if(a){so(a,`thread-follower-command-approval-decision`,{conversationId:t,requestId:n,decision:r}).catch(e=>{i.error(`Failed to forward command approval decision`,{safe:{conversationId:t},sensitive:{error:e}})});return}co(e,t,n,`item/commandExecution/requestApproval`,r)}',
        'function lo(e,t,n,r){let a=oo(e,t);if(a){so(a,`thread-follower-command-approval-decision`,{conversationId:t,requestId:n,decision:r}).catch(a=>{if(String(a).includes(`no-client-found`)||String(a).includes(`client-not-found`)||String(a).includes(`client-disconnected`)||String(a).includes(`timeout`)||String(a).includes(`request-timeout`)||String(a).includes(`Please continue this conversation on the window where it was started.`)){co(e,t,n,`item/commandExecution/requestApproval`,r);return}i.error(`Failed to forward command approval decision`,{safe:{conversationId:t},sensitive:{error:a}})});return}co(e,t,n,`item/commandExecution/requestApproval`,r)}/*__vibeControlApprovalFallback*/',
      ],
      [
        'function uo(e,t,n,r){let a=oo(e,t);if(a){so(a,`thread-follower-file-approval-decision`,{conversationId:t,requestId:n,decision:r}).catch(a=>{if(String(a).includes(`no-client-found`)||String(a).includes(`client-not-found`)||String(a).includes(`client-disconnected`)||String(a).includes(`timeout`)||String(a).includes(`request-timeout`)){co(e,t,n,`item/fileChange/requestApproval`,r);return}i.error(`Failed to forward file approval decision`,{safe:{conversationId:t},sensitive:{error:a}})});return}co(e,t,n,`item/fileChange/requestApproval`,r)}/*__vibeControlApprovalFallback*/',
        'function uo(e,t,n,r){let a=oo(e,t);if(a){so(a,`thread-follower-file-approval-decision`,{conversationId:t,requestId:n,decision:r}).catch(a=>{if(String(a).includes(`no-client-found`)||String(a).includes(`client-not-found`)||String(a).includes(`client-disconnected`)||String(a).includes(`timeout`)||String(a).includes(`request-timeout`)||String(a).includes(`Please continue this conversation on the window where it was started.`)){co(e,t,n,`item/fileChange/requestApproval`,r);return}i.error(`Failed to forward file approval decision`,{safe:{conversationId:t},sensitive:{error:a}})});return}co(e,t,n,`item/fileChange/requestApproval`,r)}/*__vibeControlApprovalFallback*/',
      ],
      [
        'function uo(e,t,n,r){let a=oo(e,t);if(a){so(a,`thread-follower-file-approval-decision`,{conversationId:t,requestId:n,decision:r}).catch(e=>{i.error(`Failed to forward file approval decision`,{safe:{conversationId:t},sensitive:{error:e}})});return}co(e,t,n,`item/fileChange/requestApproval`,r)}',
        'function uo(e,t,n,r){let a=oo(e,t);if(a){so(a,`thread-follower-file-approval-decision`,{conversationId:t,requestId:n,decision:r}).catch(a=>{if(String(a).includes(`no-client-found`)||String(a).includes(`client-not-found`)||String(a).includes(`client-disconnected`)||String(a).includes(`timeout`)||String(a).includes(`request-timeout`)||String(a).includes(`Please continue this conversation on the window where it was started.`)){co(e,t,n,`item/fileChange/requestApproval`,r);return}i.error(`Failed to forward file approval decision`,{safe:{conversationId:t},sensitive:{error:a}})});return}co(e,t,n,`item/fileChange/requestApproval`,r)}/*__vibeControlApprovalFallback*/',
      ],
      [
        'function fo(e,t,n,r){let o=oo(e,t);if(o){so(o,`thread-follower-submit-user-input`,{conversationId:t,requestId:n,response:r}).catch(s=>{if(String(s).includes(`no-client-found`)||String(s).includes(`client-not-found`)||String(s).includes(`client-disconnected`)||String(s).includes(`timeout`)||String(s).includes(`request-timeout`)){let o=e.getConversationRequest(t,n);if(!o)return;if(o.method!==`item/tool/requestUserInput`){i.error(`Unexpected user input request method`,{safe:{method:o.method},sensitive:{}});return}let c={};for(let[e,t]of Object.entries(r.answers))t&&(c[e]=[...t.answers]);let l={id:n,result:r};i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:o.method,response:l.result}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:l}),e.applyUserInputResponse(t,n,o.params,c);return}i.error(`Failed to forward user-input response`,{safe:{conversationId:t},sensitive:{error:s}})});return}let s=e.getConversationRequest(t,n);if(!s)return;if(s.method!==`item/tool/requestUserInput`){i.error(`Unexpected user input request method`,{safe:{method:s.method},sensitive:{}});return}let c={};for(let[e,t]of Object.entries(r.answers))t&&(c[e]=[...t.answers]);let l={id:n,result:r};i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:s.method,response:l.result}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:l}),e.applyUserInputResponse(t,n,s.params,c)}/*__vibeControlApprovalFallback*/',
        'function fo(e,t,n,r){let o=oo(e,t);if(o){so(o,`thread-follower-submit-user-input`,{conversationId:t,requestId:n,response:r}).catch(s=>{if(String(s).includes(`no-client-found`)||String(s).includes(`client-not-found`)||String(s).includes(`client-disconnected`)||String(s).includes(`timeout`)||String(s).includes(`request-timeout`)||String(s).includes(`Please continue this conversation on the window where it was started.`)){let o=e.getConversationRequest(t,n);if(!o)return;if(o.method!==`item/tool/requestUserInput`){i.error(`Unexpected user input request method`,{safe:{method:o.method},sensitive:{}});return}let c={};for(let[e,t]of Object.entries(r.answers))t&&(c[e]=[...t.answers]);let l={id:n,result:r};i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:o.method,response:l.result}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:l}),e.applyUserInputResponse(t,n,o.params,c);return}i.error(`Failed to forward user-input response`,{safe:{conversationId:t},sensitive:{error:s}})});return}let s=e.getConversationRequest(t,n);if(!s)return;if(s.method!==`item/tool/requestUserInput`){i.error(`Unexpected user input request method`,{safe:{method:s.method},sensitive:{}});return}let c={};for(let[e,t]of Object.entries(r.answers))t&&(c[e]=[...t.answers]);let l={id:n,result:r};i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:s.method,response:l.result}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:l}),e.applyUserInputResponse(t,n,s.params,c)}/*__vibeControlApprovalFallback*/',
      ],
      [
        'function fo(e,t,n,r){let o=oo(e,t);if(o){so(o,`thread-follower-submit-user-input`,{conversationId:t,requestId:n,response:r}).catch(e=>{i.error(`Failed to forward user-input response`,{safe:{conversationId:t},sensitive:{error:e}})});return}let s=e.getConversationRequest(t,n);if(!s)return;if(s.method!==`item/tool/requestUserInput`){i.error(`Unexpected user input request method`,{safe:{method:s.method},sensitive:{}});return}let c={};for(let[e,t]of Object.entries(r.answers))t&&(c[e]=[...t.answers]);let l={id:n,result:r};i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:s.method,response:l.result}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:l}),e.applyUserInputResponse(t,n,s.params,c)}',
        'function fo(e,t,n,r){let o=oo(e,t);if(o){so(o,`thread-follower-submit-user-input`,{conversationId:t,requestId:n,response:r}).catch(s=>{if(String(s).includes(`no-client-found`)||String(s).includes(`client-not-found`)||String(s).includes(`client-disconnected`)||String(s).includes(`timeout`)||String(s).includes(`request-timeout`)||String(s).includes(`Please continue this conversation on the window where it was started.`)){let o=e.getConversationRequest(t,n);if(!o)return;if(o.method!==`item/tool/requestUserInput`){i.error(`Unexpected user input request method`,{safe:{method:o.method},sensitive:{}});return}let c={};for(let[e,t]of Object.entries(r.answers))t&&(c[e]=[...t.answers]);let l={id:n,result:r};i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:o.method,response:l.result}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:l}),e.applyUserInputResponse(t,n,o.params,c);return}i.error(`Failed to forward user-input response`,{safe:{conversationId:t},sensitive:{error:s}})});return}let s=e.getConversationRequest(t,n);if(!s)return;if(s.method!==`item/tool/requestUserInput`){i.error(`Unexpected user input request method`,{safe:{method:s.method},sensitive:{}});return}let c={};for(let[e,t]of Object.entries(r.answers))t&&(c[e]=[...t.answers]);let l={id:n,result:r};i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:s.method,response:l.result}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:l}),e.applyUserInputResponse(t,n,s.params,c)}/*__vibeControlApprovalFallback*/',
      ],
      [
        'function po(e,t,n,r){let o=oo(e,t);if(o){so(o,`thread-follower-submit-mcp-server-elicitation-response`,{conversationId:t,requestId:n,response:r}).catch(o=>{if(String(o).includes(`no-client-found`)||String(o).includes(`client-not-found`)||String(o).includes(`client-disconnected`)||String(o).includes(`timeout`)||String(o).includes(`request-timeout`)){let s=e.getConversationRequest(t,n);if(s){if(s.method!==`mcpServer/elicitation/request`){i.error(`Unexpected MCP server elicitation request method`,{safe:{method:s.method},sensitive:{}});return}i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:s.method,response:r}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:{id:n,result:r}}),e.applyMcpServerElicitationResponse(t,n,s.params,r.action)}return}i.error(`Failed to forward MCP server elicitation response`,{safe:{conversationId:t},sensitive:{error:o}})});return}let s=e.getConversationRequest(t,n);if(s){if(s.method!==`mcpServer/elicitation/request`){i.error(`Unexpected MCP server elicitation request method`,{safe:{method:s.method},sensitive:{}});return}i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:s.method,response:r}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:{id:n,result:r}}),e.applyMcpServerElicitationResponse(t,n,s.params,r.action)}}/*__vibeControlApprovalFallback*/var mo=`Please continue this conversation on the window where it was started.`,',
        'function po(e,t,n,r){let o=oo(e,t);if(o){so(o,`thread-follower-submit-mcp-server-elicitation-response`,{conversationId:t,requestId:n,response:r}).catch(o=>{if(String(o).includes(`no-client-found`)||String(o).includes(`client-not-found`)||String(o).includes(`client-disconnected`)||String(o).includes(`timeout`)||String(o).includes(`request-timeout`)||String(o).includes(`Please continue this conversation on the window where it was started.`)){let s=e.getConversationRequest(t,n);if(s){if(s.method!==`mcpServer/elicitation/request`){i.error(`Unexpected MCP server elicitation request method`,{safe:{method:s.method},sensitive:{}});return}i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:s.method,response:r}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:{id:n,result:r}}),e.applyMcpServerElicitationResponse(t,n,s.params,r.action)}return}i.error(`Failed to forward MCP server elicitation response`,{safe:{conversationId:t},sensitive:{error:o}})});return}let s=e.getConversationRequest(t,n);if(s){if(s.method!==`mcpServer/elicitation/request`){i.error(`Unexpected MCP server elicitation request method`,{safe:{method:s.method},sensitive:{}});return}i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:s.method,response:r}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:{id:n,result:r}}),e.applyMcpServerElicitationResponse(t,n,s.params,r.action)}}/*__vibeControlApprovalFallback*/var mo=`Please continue this conversation on the window where it was started.`,',
      ],
      [
        'function po(e,t,n,r){let o=oo(e,t);if(o){so(o,`thread-follower-submit-mcp-server-elicitation-response`,{conversationId:t,requestId:n,response:r}).catch(e=>{i.error(`Failed to forward MCP server elicitation response`,{safe:{conversationId:t},sensitive:{error:e}})});return}let s=e.getConversationRequest(t,n);if(s){if(s.method!==`mcpServer/elicitation/request`){i.error(`Unexpected MCP server elicitation request method`,{safe:{method:s.method},sensitive:{}});return}i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:s.method,response:r}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:{id:n,result:r}}),e.applyMcpServerElicitationResponse(t,n,s.params,r.action)}}var mo=`Please continue this conversation on the window where it was started.`,',
        'function po(e,t,n,r){let o=oo(e,t);if(o){so(o,`thread-follower-submit-mcp-server-elicitation-response`,{conversationId:t,requestId:n,response:r}).catch(o=>{if(String(o).includes(`no-client-found`)||String(o).includes(`client-not-found`)||String(o).includes(`client-disconnected`)||String(o).includes(`timeout`)||String(o).includes(`request-timeout`)||String(o).includes(`Please continue this conversation on the window where it was started.`)){let s=e.getConversationRequest(t,n);if(s){if(s.method!==`mcpServer/elicitation/request`){i.error(`Unexpected MCP server elicitation request method`,{safe:{method:s.method},sensitive:{}});return}i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:s.method,response:r}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:{id:n,result:r}}),e.applyMcpServerElicitationResponse(t,n,s.params,r.action)}return}i.error(`Failed to forward MCP server elicitation response`,{safe:{conversationId:t},sensitive:{error:o}})});return}let s=e.getConversationRequest(t,n);if(s){if(s.method!==`mcpServer/elicitation/request`){i.error(`Unexpected MCP server elicitation request method`,{safe:{method:s.method},sensitive:{}});return}i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:s.method,response:r}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:{id:n,result:r}}),e.applyMcpServerElicitationResponse(t,n,s.params,r.action)}}/*__vibeControlApprovalFallback*/var mo=`Please continue this conversation on the window where it was started.`,',
      ],
    ];
    for (const [target, replacement] of approvalFallbackReplacements) {
      const nextContent = replaceAllLiteral(hooksContent, target, replacement);
      if (nextContent !== hooksContent) {
        hooksContent = nextContent;
        hooksChanged = true;
      }
    }

    const approvalFallbackHardeningReplacements: Array<[string, string]> = [
      [
        'function lo(e,t,n,r){let a=oo(e,t);if(a){so(a,`thread-follower-command-approval-decision`,{conversationId:t,requestId:n,decision:r}).catch(a=>{if(String(a).includes(`no-client-found`)||String(a).includes(`client-not-found`)||String(a).includes(`client-disconnected`)||String(a).includes(`timeout`)||String(a).includes(`request-timeout`)||String(a).includes(`Please continue this conversation on the window where it was started.`)){co(e,t,n,`item/commandExecution/requestApproval`,r);return}i.error(`Failed to forward command approval decision`,{safe:{conversationId:t},sensitive:{error:a}})});return}co(e,t,n,`item/commandExecution/requestApproval`,r)}/*__vibeControlApprovalFallback*/',
        'function lo(e,t,n,r){let a=oo(e,t);if(a){so(a,`thread-follower-command-approval-decision`,{conversationId:t,requestId:n,decision:r}).catch(a=>{let o=String(a);if(o.includes(`no-client-found`)||o.includes(`client-not-found`)||o.includes(`client-disconnected`)||o.includes(`Please continue this conversation on the window where it was started.`)){co(e,t,n,`item/commandExecution/requestApproval`,r);return}i.error(`Failed to forward command approval decision`,{safe:{conversationId:t},sensitive:{error:a}})});return}co(e,t,n,`item/commandExecution/requestApproval`,r)}/*__vibeControlApprovalFallback*/',
      ],
      [
        'function uo(e,t,n,r){let a=oo(e,t);if(a){so(a,`thread-follower-file-approval-decision`,{conversationId:t,requestId:n,decision:r}).catch(a=>{if(String(a).includes(`no-client-found`)||String(a).includes(`client-not-found`)||String(a).includes(`client-disconnected`)||String(a).includes(`timeout`)||String(a).includes(`request-timeout`)||String(a).includes(`Please continue this conversation on the window where it was started.`)){co(e,t,n,`item/fileChange/requestApproval`,r);return}i.error(`Failed to forward file approval decision`,{safe:{conversationId:t},sensitive:{error:a}})});return}co(e,t,n,`item/fileChange/requestApproval`,r)}/*__vibeControlApprovalFallback*/',
        'function uo(e,t,n,r){let a=oo(e,t);if(a){so(a,`thread-follower-file-approval-decision`,{conversationId:t,requestId:n,decision:r}).catch(a=>{let o=String(a);if(o.includes(`no-client-found`)||o.includes(`client-not-found`)||o.includes(`client-disconnected`)||o.includes(`Please continue this conversation on the window where it was started.`)){co(e,t,n,`item/fileChange/requestApproval`,r);return}i.error(`Failed to forward file approval decision`,{safe:{conversationId:t},sensitive:{error:a}})});return}co(e,t,n,`item/fileChange/requestApproval`,r)}/*__vibeControlApprovalFallback*/',
      ],
      [
        'function fo(e,t,n,r){let o=oo(e,t);if(o){so(o,`thread-follower-submit-user-input`,{conversationId:t,requestId:n,response:r}).catch(s=>{if(String(s).includes(`no-client-found`)||String(s).includes(`client-not-found`)||String(s).includes(`client-disconnected`)||String(s).includes(`timeout`)||String(s).includes(`request-timeout`)||String(s).includes(`Please continue this conversation on the window where it was started.`)){let o=e.getConversationRequest(t,n);if(!o)return;if(o.method!==`item/tool/requestUserInput`){i.error(`Unexpected user input request method`,{safe:{method:o.method},sensitive:{}});return}let c={};for(let[e,t]of Object.entries(r.answers))t&&(c[e]=[...t.answers]);let l={id:n,result:r};i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:o.method,response:l.result}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:l}),e.applyUserInputResponse(t,n,o.params,c);return}i.error(`Failed to forward user-input response`,{safe:{conversationId:t},sensitive:{error:s}})});return}let s=e.getConversationRequest(t,n);if(!s)return;if(s.method!==`item/tool/requestUserInput`){i.error(`Unexpected user input request method`,{safe:{method:s.method},sensitive:{}});return}let c={};for(let[e,t]of Object.entries(r.answers))t&&(c[e]=[...t.answers]);let l={id:n,result:r};i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:s.method,response:l.result}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:l}),e.applyUserInputResponse(t,n,s.params,c)}/*__vibeControlApprovalFallback*/',
        'function fo(e,t,n,r){let o=oo(e,t);if(o){so(o,`thread-follower-submit-user-input`,{conversationId:t,requestId:n,response:r}).catch(s=>{let o=String(s);if(o.includes(`no-client-found`)||o.includes(`client-not-found`)||o.includes(`client-disconnected`)||o.includes(`Please continue this conversation on the window where it was started.`)){let o=e.getLocalConversationRequest(t,n);if(!o)return;if(o.method!==`item/tool/requestUserInput`){i.error(`Unexpected user input request method`,{safe:{method:o.method},sensitive:{}});return}let c={};for(let[e,t]of Object.entries(r.answers))t&&(c[e]=[...t.answers]);let l={id:n,result:r};i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:o.method,response:l.result}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:l}),e.applyUserInputResponse(t,n,o.params,c);return}i.error(`Failed to forward user-input response`,{safe:{conversationId:t},sensitive:{error:s}})});return}let s=e.getLocalConversationRequest(t,n);if(!s)return;if(s.method!==`item/tool/requestUserInput`){i.error(`Unexpected user input request method`,{safe:{method:s.method},sensitive:{}});return}let c={};for(let[e,t]of Object.entries(r.answers))t&&(c[e]=[...t.answers]);let l={id:n,result:r};i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:s.method,response:l.result}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:l}),e.applyUserInputResponse(t,n,s.params,c)}/*__vibeControlApprovalFallback*/',
      ],
      [
        'function po(e,t,n,r){let o=oo(e,t);if(o){so(o,`thread-follower-submit-mcp-server-elicitation-response`,{conversationId:t,requestId:n,response:r}).catch(o=>{if(String(o).includes(`no-client-found`)||String(o).includes(`client-not-found`)||String(o).includes(`client-disconnected`)||String(o).includes(`timeout`)||String(o).includes(`request-timeout`)||String(o).includes(`Please continue this conversation on the window where it was started.`)){let s=e.getConversationRequest(t,n);if(s){if(s.method!==`mcpServer/elicitation/request`){i.error(`Unexpected MCP server elicitation request method`,{safe:{method:s.method},sensitive:{}});return}i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:s.method,response:r}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:{id:n,result:r}}),e.applyMcpServerElicitationResponse(t,n,s.params,r.action)}return}i.error(`Failed to forward MCP server elicitation response`,{safe:{conversationId:t},sensitive:{error:o}})});return}let s=e.getConversationRequest(t,n);if(s){if(s.method!==`mcpServer/elicitation/request`){i.error(`Unexpected MCP server elicitation request method`,{safe:{method:s.method},sensitive:{}});return}i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:s.method,response:r}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:{id:n,result:r}}),e.applyMcpServerElicitationResponse(t,n,s.params,r.action)}}/*__vibeControlApprovalFallback*/var mo=`Please continue this conversation on the window where it was started.`,',
        'function po(e,t,n,r){let o=oo(e,t);if(o){so(o,`thread-follower-submit-mcp-server-elicitation-response`,{conversationId:t,requestId:n,response:r}).catch(o=>{let s=String(o);if(s.includes(`no-client-found`)||s.includes(`client-not-found`)||s.includes(`client-disconnected`)||s.includes(`Please continue this conversation on the window where it was started.`)){let c=e.getLocalConversationRequest(t,n);if(c){if(c.method!==`mcpServer/elicitation/request`){i.error(`Unexpected MCP server elicitation request method`,{safe:{method:c.method},sensitive:{}});return}i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:c.method,response:r}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:{id:n,result:r}}),e.applyMcpServerElicitationResponse(t,n,c.params,r.action)}return}i.error(`Failed to forward MCP server elicitation response`,{safe:{conversationId:t},sensitive:{error:o}})});return}let s=e.getLocalConversationRequest(t,n);if(s){if(s.method!==`mcpServer/elicitation/request`){i.error(`Unexpected MCP server elicitation request method`,{safe:{method:s.method},sensitive:{}});return}i.info(`Sending server response`,{safe:{},sensitive:{id:n,method:s.method,response:r}}),a.dispatchMessage(`mcp-response`,{hostId:e.hostId,response:{id:n,result:r}}),e.applyMcpServerElicitationResponse(t,n,s.params,r.action)}}/*__vibeControlApprovalFallback*/var mo=`Please continue this conversation on the window where it was started.`,',
      ],
    ];
    for (const [target, replacement] of approvalFallbackHardeningReplacements) {
      const nextContent = replaceAllLiteral(hooksContent, target, replacement);
      if (nextContent !== hooksContent) {
        hooksContent = nextContent;
        hooksChanged = true;
      }
    }

    const hydrationLoggingReplacements: Array<[string, string]> = [
      [
        'void n.hydratePinnedThreads([e]).catch(()=>{})',
        'void n.hydratePinnedThreads([e]).catch(t=>{console.warn("[Vibe Control] hydratePinnedThreads failed",e,t)})',
      ],
      [
        'void r.hydratePinnedThreads([e]).catch(()=>{})',
        'void r.hydratePinnedThreads([e]).catch(t=>{console.warn("[Vibe Control] hydratePinnedThreads failed",e,t)})',
      ],
      [
        'void a.hydratePinnedThreads([e]).catch(()=>{})',
        'void a.hydratePinnedThreads([e]).catch(t=>{console.warn("[Vibe Control] hydratePinnedThreads failed",e,t)})',
      ],
    ];
    for (const [target, replacement] of hydrationLoggingReplacements) {
      const nextContent = replaceAllLiteral(hooksContent, target, replacement);
      if (nextContent !== hooksContent) {
        hooksContent = nextContent;
        hooksChanged = true;
      }
    }

    const streamRecoveryReplacements: Array<[string, string]> = [
      [
        'this.updateTurnState(r,t.id,e=>{if(e.turnId=t.id,e.status=t.status,e.error=t.error,t.status!==`completed`)return;let n=(0,sa.default)(e.items,e=>e.type===`todo-list`);if(n){let e=n.plan.filter(e=>e.status===`completed`).length;e<n.plan.length&&(o=n.plan.length,s=e)}let r=(0,sa.default)(e.items,e=>e.type===`plan`);if(!r)return;let i=r.text.trim();i.length!==0&&(a=i)})',
        'this.updateTurnState(r,t.id,e=>{if(e.turnId=t.id,e.status=t.status,e.error=t.error,t.status!==`completed`)return;let n=(0,sa.default)(e.items,e=>e.type===`todo-list`);if(n){let e=n.plan.filter(e=>e.status===`completed`).length;e<n.plan.length&&(o=n.plan.length,s=e)}let r=(0,sa.default)(e.items,e=>e.type===`plan`);if(!r)return;let i=r.text.trim();i.length!==0&&(a=i)},!0,{rebindLatestInProgressPlaceholder:!0})/*__vibeControlStreamRecovery*/',
      ],
      [
        'let n=e.type===`userMessage`?Ph(t,r):r==null?(0,$.default)(t.turns)??null:(0,sa.default)(t.turns,e=>e.turnId===r)??null;',
        'let n=e.type===`userMessage`?Ph(t,r,{rebindLatestInProgressPlaceholder:!0}):r==null?(0,$.default)(t.turns)??null:Ph(t,r,{rebindLatestInProgressPlaceholder:!0});/*__vibeControlStreamRecovery*/',
      ],
      [
        '},!1)}applyFrameTextDeltas(e){if(e.length===0)return;let t=new Map;for(let n of e){let e=t.get(n.conversationId);e?e.push(n):t.set(n.conversationId,[n])}for(let[e,n]of t)this.updateConversationState(e,e=>{for(let t of n){let n=Ph(e,t.turnId);if(n)switch(t.target.type){',
        '},!1,{rebindLatestInProgressPlaceholder:!0})}applyFrameTextDeltas(e){if(e.length===0)return;let t=new Map;for(let n of e){let e=t.get(n.conversationId);e?e.push(n):t.set(n.conversationId,[n])}for(let[e,n]of t)this.updateConversationState(e,e=>{for(let t of n){let n=Ph(e,t.turnId,{rebindLatestInProgressPlaceholder:!0});if(n)switch(t.target.type){/*__vibeControlStreamRecovery*/',
      ],
    ];
    for (const [target, replacement] of streamRecoveryReplacements) {
      const nextContent = replaceAllLiteral(hooksContent, target, replacement);
      if (nextContent !== hooksContent) {
        hooksContent = nextContent;
        hooksChanged = true;
      }
    }

    const hydrateMarker = '__vibeControlHydrateLocalConversation';
    if (!hooksContent.includes(hydrateMarker)) {
      const localConversationTarget =
        'function Cg(e){let t=(0,H.c)(6),n=Sg(e),r;t[0]!==n||t[1]!==e?(r=t=>ug(n,e,t),t[0]=n,t[1]=e,t[2]=r):r=t[2];let i=r,a;return t[3]!==n||t[4]!==e?(a=()=>e==null?null:n.getConversation(e)??null,t[3]=n,t[4]=e,t[5]=a):a=t[5],(0,I.useSyncExternalStore)(i,a)}';
      const localConversationReplacement =
        'function Cg(e){let t=(0,H.c)(6),n=Sg(e),r;t[0]!==n||t[1]!==e?(r=t=>ug(n,e,t),t[0]=n,t[1]=e,t[2]=r):r=t[2];let i=r,a;t[3]!==n||t[4]!==e?(a=()=>e==null?null:n.getConversation(e)??null,t[3]=n,t[4]=e,t[5]=a):a=t[5],(0,I.useEffect)(()=>{e!=null&&n.getConversation(e)==null&&void n.hydratePinnedThreads([e]).catch(()=>{})},[n,e]);return(0,I.useSyncExternalStore)(i,a)}/*__vibeControlHydrateLocalConversation*/';
      if (hooksContent.includes(localConversationTarget)) {
        hooksContent = hooksContent.replace(localConversationTarget, localConversationReplacement);
        hooksChanged = true;
      }

      const localSelectorTarget =
        'function wg(e,t){let n=(0,H.c)(7),r=Sg(e),i;n[0]!==r||n[1]!==e?(i=t=>ug(r,e,t),n[0]=r,n[1]=e,n[2]=i):i=n[2];let a=i,o;return n[3]!==r||n[4]!==e||n[5]!==t?(o=()=>t(e==null?null:r.getConversation(e)??null),n[3]=r,n[4]=e,n[5]=t,n[6]=o):o=n[6],(0,I.useSyncExternalStore)(a,o)}';
      const localSelectorReplacement =
        'function wg(e,t){let n=(0,H.c)(7),r=Sg(e),i;n[0]!==r||n[1]!==e?(i=t=>ug(r,e,t),n[0]=r,n[1]=e,n[2]=i):i=n[2];let a=i,o;n[3]!==r||n[4]!==e||n[5]!==t?(o=()=>t(e==null?null:r.getConversation(e)??null),n[3]=r,n[4]=e,n[5]=t,n[6]=o):o=n[6],(0,I.useEffect)(()=>{e!=null&&r.getConversation(e)==null&&void r.hydratePinnedThreads([e]).catch(()=>{})},[r,e]);return(0,I.useSyncExternalStore)(a,o)}/*__vibeControlHydrateLocalConversation*/';
      if (hooksContent.includes(localSelectorTarget)) {
        hooksContent = hooksContent.replace(localSelectorTarget, localSelectorReplacement);
        hooksChanged = true;
      }

      const localConversationTargetCurrent =
        'function a_(e,t,n){let r=(0,L.c)(8),i=n===void 0?Object.is:n,a=i_(e),o;r[0]!==a||r[1]!==e?(o=t=>Wg(a,e,t),r[0]=a,r[1]=e,r[2]=o):o=r[2];let s=o,c=(0,I.useRef)(null),l=(0,I.useRef)(!1),u;return r[3]!==a||r[4]!==e||r[5]!==i||r[6]!==t?(u=()=>{let n=t(e==null?null:a.getConversation(e)??null);if(l.current){let e=c.current;if(i(e,n))return e}return l.current=!0,c.current=n,n},r[3]=a,r[4]=e,r[5]=i,r[6]=t,r[7]=u):u=r[7],(0,I.useSyncExternalStore)(s,u)}';
      const localConversationReplacementCurrent =
        'function a_(e,t,n){let r=(0,L.c)(8),i=n===void 0?Object.is:n,a=i_(e),o;r[0]!==a||r[1]!==e?(o=t=>Wg(a,e,t),r[0]=a,r[1]=e,r[2]=o):o=r[2];let s=o,c=(0,I.useRef)(null),l=(0,I.useRef)(!1),u;return r[3]!==a||r[4]!==e||r[5]!==i||r[6]!==t?(u=()=>{let n=t(e==null?null:a.getConversation(e)??null);if(l.current){let e=c.current;if(i(e,n))return e}return l.current=!0,c.current=n,n},r[3]=a,r[4]=e,r[5]=i,r[6]=t,r[7]=u):u=r[7],(0,I.useEffect)(()=>{e!=null&&a.getConversation(e)==null&&void a.hydratePinnedThreads([e]).catch(()=>{})},[a,e]),(0,I.useSyncExternalStore)(s,u)}/*__vibeControlHydrateLocalConversation*/';
      if (hooksContent.includes(localConversationTargetCurrent)) {
        hooksContent = hooksContent.replace(localConversationTargetCurrent, localConversationReplacementCurrent);
        hooksChanged = true;
      }

      const localConversationTargetLatest =
        'function qg(e,t,n){let r=(0,L.c)(8),i=n===void 0?Object.is:n,a=Kg(e),o;r[0]!==a||r[1]!==e?(o=t=>Mg(a,e,t),r[0]=a,r[1]=e,r[2]=o):o=r[2];let s=o,c=(0,I.useRef)(null),l=(0,I.useRef)(!1),u;return r[3]!==a||r[4]!==e||r[5]!==i||r[6]!==t?(u=()=>{let n=t(e==null?null:a.getConversation(e)??null);if(l.current){let e=c.current;if(i(e,n))return e}return l.current=!0,c.current=n,n},r[3]=a,r[4]=e,r[5]=i,r[6]=t,r[7]=u):u=r[7],(0,I.useSyncExternalStore)(s,u)}';
      const localConversationReplacementLatest =
        'function qg(e,t,n){let r=(0,L.c)(8),i=n===void 0?Object.is:n,a=Kg(e),o;r[0]!==a||r[1]!==e?(o=t=>Mg(a,e,t),r[0]=a,r[1]=e,r[2]=o):o=r[2];let s=o,c=(0,I.useRef)(null),l=(0,I.useRef)(!1),u;return r[3]!==a||r[4]!==e||r[5]!==i||r[6]!==t?(u=()=>{let n=t(e==null?null:a.getConversation(e)??null);if(l.current){let e=c.current;if(i(e,n))return e}return l.current=!0,c.current=n,n},r[3]=a,r[4]=e,r[5]=i,r[6]=t,r[7]=u):u=r[7],(0,I.useEffect)(()=>{e!=null&&a.getConversation(e)==null&&void a.hydratePinnedThreads([e]).catch(()=>{})},[a,e]),(0,I.useSyncExternalStore)(s,u)}/*__vibeControlHydrateLocalConversation*/';
      if (hooksContent.includes(localConversationTargetLatest)) {
        hooksContent = hooksContent.replace(localConversationTargetLatest, localConversationReplacementLatest);
        hooksChanged = true;
      }
    }

    const hooksCriticalChecks = collectMissingChecks(hooksContent, [
      { needle: '__vibeControlFollowerOwnerFallback', label: 'follower owner fallback patch' },
      { needle: 'getLocalConversationRequest:(t,n)=>{', label: 'scoped local request helper' },
      { needle: 'getConversationRequest:(t,n)=>{if(e.getStreamRole(t)?.role===`follower`)throw Error(mo);', label: 'guarded follower request accessor' },
      { needle: 'function co(e,t,n,r,o){let s=e.getLocalConversationRequest(t,n);', label: 'local approval request fallback' },
      { needle: 'if((s.includes(`Server overloaded`)||s.includes(`retry later`))&&r<1){await new Promise(e=>setTimeout(e,500));continue}', label: 'follower overload retry trigger' },
      { needle: '__vibeControlStreamRecovery', label: 'stream recovery patch' },
      { needle: 'console.warn("[Vibe Control] hydratePinnedThreads failed"', label: 'hydrate failure logging' },
      { needle: hydrateMarker, label: 'hydrate local conversation patch' },
    ]);
    if (hooksCriticalChecks.length > 0) {
      reports.push(summarizePatchState('hooks', 'anchor_missing'));
      warnings.push(`Codex hooks patch verification failed for ${appServerHooksBundle}: ${hooksCriticalChecks.join(', ')}`);
    } else if (hooksChanged) {
      reports.push(summarizePatchState('hooks', 'applied'));
      overallChanged = true;
      pendingWrites.push({ path: hooksPath, content: hooksContent });
    } else {
      reports.push(summarizePatchState('hooks', 'already_present'));
    }
  }

  const hasBlockingWarnings = warnings.some(warning =>
    warning.includes('no webview bundle matched')
    || warning.includes('no hooks bundle matched')
    || warning.includes('Failed to write patched Codex asset:')
  );

  if (hasBlockingWarnings) {
    return { changed: false, reports, warnings };
  }

  for (const pendingWrite of pendingWrites) {
    try {
      fs.writeFileSync(pendingWrite.path, pendingWrite.content, 'utf-8');
    } catch {
      reports.push(summarizePatchState(path.basename(pendingWrite.path), 'write_failed'));
      warnings.push(`Failed to write patched Codex asset: ${pendingWrite.path}`);
      return { changed: false, reports, warnings };
    }
  }

  return { changed: overallChanged, reports, warnings };
}

function patchCodexExtension(): PatchOutcome {
  let changed = false;
  const reports: string[] = [];
  const warnings: string[] = [];
  for (const target of collectCodexExtensionTargets()) {
    const result = patchCodexExtensionAtPath(target);
    changed = result.changed || changed;
    reports.push(...result.reports.map(report => `${target.version ?? 'unknown'} ${report}`));
    warnings.push(...result.warnings);
  }
  return { changed, reports, warnings };
}

function patchOriginalExtension(): {
  needsReload: boolean;
  patchedTargets: string[];
  warnings: string[];
  codexAvailability: PatchAvailability;
} {
  const patchedTargets: string[] = [];
  const warnings: string[] = [];

  if (patchClaudeExtension()) {
    patchedTargets.push('Claude Code');
  }

  const codexPatchResult = patchCodexExtension();
  warnings.push(...codexPatchResult.warnings);
  if (codexPatchResult.reports.length > 0) {
    console.info('[Vibe Control] Codex patch report:', codexPatchResult.reports);
  }
  if (codexPatchResult.changed) {
    patchedTargets.push('Codex');
  }

  const codexAvailability: PatchAvailability = codexPatchResult.warnings.length > 0
    ? 'invalid'
    : codexPatchResult.changed
      ? 'reload_required'
      : 'ready';

  return {
    needsReload: patchedTargets.length > 0,
    patchedTargets,
    warnings,
    codexAvailability,
  };
}

async function openClaudeSession(
  sessionId?: string,
  cwd?: string,
  newTab = false,
): Promise<void> {
  await ensureOfficialExtensionPatches(true);
  if (cwd) {
    try {
      g.__vibeControlCwd = fs.realpathSync(cwd).normalize('NFC');
    } catch {
      g.__vibeControlCwd = cwd;
    }
  }
  try {
    // Always use editor.open directly — Claude Code handles panel reuse internally.
    // Don't close existing panels first, as that clears sessionPanels and causes
    // Claude Code to create a brand new conversation instead of resuming.
    await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId);
  } finally {
    g.__vibeControlCwd = undefined;
  }
}

async function syncOfficialAutoApprovePermissions(enabled: boolean): Promise<void> {
  await ensureOfficialExtensionPatches(false);
  const commands = [
    'chatgpt.setVibeControlAutoApprovePermissions',
    'claude-vscode.setVibeControlAutoApprovePermissions',
    'claude-code.setVibeControlAutoApprovePermissions',
  ];
  for (const commandId of commands) {
    try {
      await vscode.commands.executeCommand(commandId, enabled);
    } catch {
      // Ignore unavailable provider commands.
    }
  }
}

async function approveOfficialPendingPermissions(): Promise<void> {
  await ensureOfficialExtensionPatches(false);
  const commands = [
    'chatgpt.approvePendingPermissionsInOpenViews',
  ];
  for (const commandId of commands) {
    try {
      await vscode.commands.executeCommand(commandId);
    } catch {
      // Ignore unavailable provider commands.
    }
  }
}

async function runCodexCanary(): Promise<string | null> {
  const codexExt = vscode.extensions.getExtension('openai.chatgpt');
  if (!codexExt) {
    return 'Official Codex extension is not installed.';
  }

  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes('chatgpt.openSidebar')) {
    return 'Official Codex commands are unavailable in this window.';
  }

  const customEditors = Array.isArray(codexExt.packageJSON?.contributes?.customEditors)
    ? codexExt.packageJSON.contributes.customEditors
    : [];
  const hasConversationEditor = customEditors.some((editor: any) => editor?.viewType === 'chatgpt.conversationEditor');
  if (!hasConversationEditor) {
    return 'Official Codex conversation editor is unavailable in this window.';
  }

  const extJsPath = path.join(codexExt.extensionPath, 'out', 'extension.js');
  if (!fs.existsSync(extJsPath)) {
    return 'Official Codex extension host bundle is missing.';
  }

  const extJsContent = fs.readFileSync(extJsPath, 'utf-8');
  const extMarkers = [
    '__vibeControlBufferedIpcBroadcasts',
    '__vibeControlFollowerResponseOrigin',
    '__vibeControlOpenConversationCommand',
  ];
  const missingExtMarkers = extMarkers.filter(marker => !extJsContent.includes(marker));
  if (missingExtMarkers.length > 0) {
    return `Codex extension host markers missing: ${missingExtMarkers.join(', ')}`;
  }

  const assetsDir = path.join(codexExt.extensionPath, 'webview', 'assets');
  const assetFiles = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  const webviewBundle = selectBundle(assetFiles, /^index-.*\.js$/, 'webview-bundle').selected;
  const hooksBundle = selectBundle(assetFiles, /^app-server-manager-hooks-.*\.js$/, 'hooks-bundle').selected;
  if (!webviewBundle || !hooksBundle) {
    return 'Official Codex webview assets are incomplete.';
  }

  const webviewContent = fs.readFileSync(path.join(assetsDir, webviewBundle), 'utf-8');
  const missingWebviewMarkers = ['__vibeControlResumeFollower', '__vibeControlTabHydration']
    .filter(marker => !webviewContent.includes(marker));
  if (missingWebviewMarkers.length > 0) {
    return `Codex webview markers missing: ${missingWebviewMarkers.join(', ')}`;
  }

  const hooksContent = fs.readFileSync(path.join(assetsDir, hooksBundle), 'utf-8');
  const missingHookMarkers = [
    '__vibeControlFollowerOwnerFallback',
    '__vibeControlApprovalFallback',
    '__vibeControlStreamRecovery',
    '__vibeControlHydrateLocalConversation',
  ].filter(marker => !hooksContent.includes(marker));
  if (missingHookMarkers.length > 0) {
    return `Codex hooks markers missing: ${missingHookMarkers.join(', ')}`;
  }

  return null;
}

function providerDescription(provider: ConversationProvider): string {
  switch (provider.id) {
    case 'claude':
      return 'Default provider for Claude Code sessions';
    case 'codex':
      return 'Codex panel mode with terminal fallback';
    default:
      return provider.label;
  }
}

let patchResultLoaded = false;
let patchWarningsShown = false;
let patchPromptShown = false;
let codexCanaryStarted = false;

async function ensureOfficialExtensionPatches(interactive = true): Promise<PatchAvailability> {
  const { needsReload, patchedTargets, warnings, codexAvailability } = patchOriginalExtension();
  patchResultLoaded = true;

  if (warnings.length > 0 && interactive && !patchWarningsShown) {
    patchWarningsShown = true;
    const summary = warnings.length === 1 ? warnings[0] : `${warnings[0]} (+${warnings.length - 1} more)`;
    void vscode.window.showWarningMessage(`Vibe Control: ${summary}`);
    console.warn('[Vibe Control] Patch warnings:', warnings);
  }

  if (needsReload && interactive && !patchPromptShown) {
    patchPromptShown = true;
    const action = await vscode.window.showInformationMessage(
      `Vibe Control: Patched ${patchedTargets.join(' and ')} for session binding. Please reload.`,
      'Reload Now',
    );
    if (action === 'Reload Now') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }

  if (codexAvailability === 'ready' && !codexCanaryStarted) {
    codexCanaryStarted = true;
    void (async () => {
      const codexCanaryFailure = await runCodexCanary();
      if (!codexCanaryFailure) {
        return;
      }
      void vscode.window.showErrorMessage(
        `Vibe Control: Official Codex canary failed. Codex sessions remain visible, but the official open path may be unstable in this window. ${codexCanaryFailure}`,
      );
    })();
  }

  return codexAvailability;
}

async function ensureProviderIntegrationReady(providerId: ConversationRecord['provider'], interactive = true): Promise<void> {
  if (providerId === 'claude' || providerId === 'codex') {
    await ensureOfficialExtensionPatches(interactive);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const sessionManager = new SessionManager();
  ensureSessionHandoffTooling(process.execPath);
  const processManager = new ProcessManager(context.extensionPath);
  const codexProcessManager = new CodexProcessManager();
  const claudeProvider = new ClaudeProvider(
    sessionManager,
    processManager,
    openClaudeSession,
    (title, onDiscovered) => waitForNewClaudeSessionAndRename(sessionManager, title, onDiscovered),
    context.extensionPath,
  );
  const codexProvider = new CodexProvider();
  const providers: ConversationProvider[] = [claudeProvider, codexProvider];
  const conversationManager = new ConversationManager(providers);
  const workingSessionTracker = new WorkingSessionTracker();
  const sessionHandoffService = new SessionHandoffService(
    conversationManager,
    processManager,
    codexProcessManager,
  );
  const sessionHandoffQueue = new SessionHandoffQueueProcessor(sessionHandoffService);
  sessionHandoffQueue.start();
  const sessionIndexService = new SessionIndexService(
    conversationManager,
    processManager,
    codexProcessManager,
    workingSessionTracker,
  );
  const terminalRegistry = new TerminalRegistry();
  terminalRegistryRef = terminalRegistry;
  const taskRegistry = new TaskRegistry();
  const conversationRootPaths = () => conversationManager.getProjectGroups()
    .map(group => group.cwd)
    .filter((cwd): cwd is string => typeof cwd === 'string' && cwd.length > 0);
  const taskDraftRegistry = new TaskDraftRegistry(conversationRootPaths);
  const noteRegistry = new NoteRegistry(conversationRootPaths);
  const workspaceEntityIndexService = new WorkspaceEntityIndexService(
    sessionIndexService,
    terminalRegistry,
    taskRegistry,
    taskDraftRegistry,
    noteRegistry,
  );
  workspaceEntityIndexServiceRef = workspaceEntityIndexService;
  const treeProvider = new SessionTreeProvider(conversationManager, noteRegistry, context.extensionPath);
  let sessionCenterPanel: SessionCenterPanel;
  const refreshSessionViews = () => {
    treeProvider.refresh();
    workspaceEntityIndexService.refresh();
    sessionCenterPanel.refresh();
  };
  const autoApprovalManager = new AutoApprovalManager(
    conversationManager,
    processManager,
    codexProcessManager,
    Boolean(context.workspaceState.get<boolean>(AUTO_APPROVE_PERMISSIONS_KEY, false)),
    async () => {
      await syncOfficialAutoApprovePermissions(true);
      await approveOfficialPendingPermissions();
    },
    refreshSessionViews,
  );
  void syncOfficialAutoApprovePermissions(autoApprovalManager.getEnabled());
  sessionCenterPanel = new SessionCenterPanel(
    context.extensionUri,
    workspaceEntityIndexService,
    context.workspaceState,
    () => autoApprovalManager.getEnabled(),
    async (value: boolean) => {
      await context.workspaceState.update(AUTO_APPROVE_PERMISSIONS_KEY, value);
      await autoApprovalManager.setEnabled(value);
      await syncOfficialAutoApprovePermissions(value);
    },
  );
  refreshNotesView = () => {
    noteRegistry.refresh();
    treeProvider.refresh();
    workspaceEntityIndexService.refresh();
    sessionCenterPanel.refresh();
  };

  const treeView = vscode.window.createTreeView('vibeSessionsList', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  const selectionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  selectionStatusBarItem.name = 'Vibe Control Selection';
  selectionStatusBarItem.command = 'vibe-control.showSessionCenter';
  refreshSelectionStatusBar = () => updateSelectionStatusBar(selectionStatusBarItem);
  refreshSelectionStatusBar();
  logDebug(`extension activated; tree view created; debugLog=${getDebugLogPath()}`);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'vibe-control.updateProviderSessionWorkingState',
      async (payload: { provider?: ConversationRecord['provider']; sessionId?: string; state?: string; raw?: unknown }) => {
        if (!payload?.provider || !payload.sessionId) { return; }
        const inferredState = inferWorkingState(payload.state, payload.raw);
        workingSessionTracker.update(payload.provider, payload.sessionId, inferredState);
      },
    ),
  );

  context.subscriptions.push(
    treeView.onDidChangeSelection((event) => {
      const selected = event.selection[0] as { conversation?: ConversationRecord } | undefined;
      const conversation = selected?.conversation;
      if (!conversation) {
        logDebug(`tree selection changed; no conversation item selected; selectionSize=${event.selection.length}`);
        return;
      }
      logDebug(`tree selection provider=${conversation.provider} id=${conversation.id} name=${conversation.name}`);
      console.info(`Vibe Control: tree selection provider=${conversation.provider} id=${conversation.id}`);
      void vscode.commands.executeCommand('vibe-control.activateSession', conversation);
    }),
  );

  context.subscriptions.push(
    workingSessionTracker.onDidChange(() => {
      refreshSessionViews();
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(() => {
      refreshSelectionStatusBar?.();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      refreshSelectionStatusBar?.();
    }),
  );

  context.subscriptions.push(
    treeView,
    selectionStatusBarItem,
    sessionManager,
    workingSessionTracker,
    terminalRegistry,
    taskRegistry,
    taskDraftRegistry,
    noteRegistry,
    autoApprovalManager,
    { dispose: () => sessionHandoffQueue.dispose() },
    workspaceEntityIndexService,
    { dispose: () => codexProvider?.dispose() },
    { dispose: () => codexProcessManager.dispose() },
    sessionCenterPanel,
  );

  context.subscriptions.push(conversationManager.onDidChange(() => {
    workspaceEntityIndexService.refresh();
    sessionCenterPanel.refresh();
  }));

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.newSession', async (options?: { projectPath?: string }) => {
      await runNewSessionFlow({
        treeProvider,
        providers,
        conversationManager,
        fixedProjectPath: options?.projectPath,
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.searchSessions', async () => {
      await showSessionSearch(sessionIndexService);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.searchWorkspace', async () => {
      await showWorkspaceSearch(workspaceEntityIndexService);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.newNote', async () => {
      await createWorkspaceNote();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.openNote', async (arg: NoteSnapshot | { note?: NoteSnapshot } | undefined) => {
      const note = normalizeNoteArg(arg);
      if (note) {
        await noteRegistry.openNote(note.id);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.appendSelectionToNote', async (arg: NoteSnapshot | { note?: NoteSnapshot } | undefined) => {
      const note = normalizeNoteArg(arg);
      if (!note) { return; }
      await appendEditorSelectionToExistingNote(note);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.copyNotePath', async (arg: NoteSnapshot | { note?: NoteSnapshot } | undefined) => {
      const note = normalizeNoteArg(arg);
      if (!note) { return; }
      await vscode.env.clipboard.writeText(note.absolutePath);
      void vscode.window.showInformationMessage(`Copied note path: ${note.absolutePath}`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.deleteNote', async (arg: NoteSnapshot | { note?: NoteSnapshot } | undefined) => {
      const note = normalizeNoteArg(arg);
      if (!note) { return; }

      const confirm = await vscode.window.showWarningMessage(
        `Delete note "${truncate(note.title, 40)}"? This cannot be undone.`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') { return; }
      if (!fs.existsSync(note.absolutePath)) {
        void vscode.window.showWarningMessage('Note file not found.');
        return;
      }

      try {
        fs.unlinkSync(note.absolutePath);
        refreshNotesView?.();
        void vscode.window.showInformationMessage('Note deleted.');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Failed to delete note: ${message}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.addSelectionToNote', async () => {
      await addEditorSelectionToNote();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.addSelectionToNoteFromWebviewPayload', async (payload: WebviewSelectionPayload) => {
      const key = JSON.stringify(payload);
      if (key === lastHandledWebviewSelectionToNoteKey && Date.now() - lastHandledWebviewSelectionToNoteAt < 1000) {
        return;
      }
      lastHandledWebviewSelectionToNoteKey = key;
      lastHandledWebviewSelectionToNoteAt = Date.now();
      await addWebviewSelectionToNote(payload, workspaceEntityIndexService);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.updateWebviewSelectionPayload', async (payload: WebviewSelectionPayload | null) => {
      const length = typeof payload?.text === 'string' ? payload.text.trim().length : 0;
      console.info(`Vibe Control Selection: update provider=${payload?.provider ?? 'none'} length=${length} route=${payload?.route ?? ''}`);
      logDebug(`selection update provider=${payload?.provider ?? 'none'} length=${length} route=${payload?.route ?? ''}`);
      setLatestWebviewSelection(payload);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.newNoteFromEntity', async (entity: WorkspaceEntity) => {
      await createWorkspaceNote({ entity });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.convertNoteToTask', async (note: NoteSnapshot) => {
      await convertNoteToTaskDraft(note);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.showSessionCenter', async () => {
      sessionCenterPanel.show();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.activateSession', async (arg: ConversationRecord | string, cwd?: string) => {
      const conversation = resolveConversationCommandArg(conversationManager, arg, cwd);
      if (!conversation) {
        logDebug(`activateSession failed to resolve conversation argShape=${describeCommandArg(arg)} cwd=${cwd ?? ''}`);
        return;
      }
      logDebug(`activateSession provider=${conversation.provider} id=${conversation.id} name=${conversation.name}`);
      console.info(`Vibe Control: activateSession clicked provider=${conversation.provider} id=${conversation.id}`);
      const provider = conversationManager.getProvider(conversation.provider);
      if (!provider) {
        logDebug(`activateSession missing provider id=${conversation.provider}`);
        return;
      }
      await ensureProviderIntegrationReady(conversation.provider, true);
      if (provider.activateConversation) {
        try {
          await provider.activateConversation(conversation);
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logDebug(`activateSession primary open failed provider=${conversation.provider} id=${conversation.id} error=${message}`);
          if (conversation.provider === 'codex') {
            logDebug(`activateSession falling back to openConversation for codex id=${conversation.id}`);
            await provider.openConversation(conversation, false);
            return;
          }
          throw error;
        }
      }
      await provider.openConversation(conversation, false);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.contextOpenSession', async (arg: unknown, cwd?: string) => {
      logDebug(`contextOpenSession clicked argShape=${describeCommandArg(arg)} cwd=${cwd ?? ''}`);
      const conversation = resolveConversationCommandArg(conversationManager, arg, cwd);
      if (!conversation) {
        logDebug(`contextOpenSession failed to resolve conversation`);
        return;
      }
      logDebug(`contextOpenSession resolved provider=${conversation.provider} id=${conversation.id} name=${conversation.name}`);
      const provider = conversationManager.getProvider(conversation.provider);
      if (!provider) {
        logDebug(`contextOpenSession missing provider id=${conversation.provider}`);
        return;
      }
      await ensureProviderIntegrationReady(conversation.provider, true);
      if (provider.activateConversation) {
        await provider.activateConversation(conversation);
        return;
      }
      await provider.openConversation(conversation, false);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.openSession', async (arg: unknown, cwd?: string) => {
      const conversation = resolveConversationCommandArg(conversationManager, arg, cwd);
      if (!conversation) { return; }
      const provider = conversationManager.getProvider(conversation.provider);
      if (!provider) { return; }
      await ensureProviderIntegrationReady(conversation.provider, true);
      await provider.openConversation(conversation, false);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.openSessionCliInTerminal', async (arg: unknown, cwd?: string) => {
      const conversation = resolveConversationCommandArg(conversationManager, arg, cwd);
      if (!conversation) { return; }
      const provider = conversationManager.getProvider(conversation.provider);
      if (!provider?.openConversationInTerminal) {
        void vscode.window.showInformationMessage(`Terminal CLI is not available for ${conversation.provider}.`);
        return;
      }
      await provider.openConversationInTerminal(conversation);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.handoffSession', async (arg: unknown, cwd?: string) => {
      const conversation = resolveConversationCommandArg(conversationManager, arg, cwd);
      if (!conversation) { return; }
      await runSessionHandoffFlow({
        sourceConversation: conversation,
        conversationManager,
        sessionIndexService,
        sessionHandoffService,
        refreshViews: refreshSessionViews,
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.stopSession', async (arg: unknown, cwd?: string) => {
      const conversation = resolveConversationCommandArg(conversationManager, arg, cwd);
      if (!conversation) { return; }
      const stopped = conversation.provider === 'codex'
        ? codexProcessManager.stopProcess(conversation.id)
        : processManager.stopProcess(conversation.id);
      if (!stopped) {
        void vscode.window.showInformationMessage(`No running session to stop: ${conversation.name}`);
        return;
      }
      conversationManager.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.interruptSession', async (arg: unknown, cwd?: string) => {
      const conversation = resolveConversationCommandArg(conversationManager, arg, cwd);
      if (!conversation) { return; }
      const interrupted = conversation.provider === 'codex'
        ? codexProcessManager.interruptProcess(conversation.id)
        : processManager.interruptProcess(conversation.id);
      if (!interrupted) {
        void vscode.window.showInformationMessage(`No running session to interrupt: ${conversation.name}`);
        return;
      }
      conversationManager.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.contextOpenSessionNewTab', async (arg: unknown, cwd?: string) => {
      logDebug(`contextOpenSessionNewTab clicked argShape=${describeCommandArg(arg)} cwd=${cwd ?? ''}`);
      const conversation = resolveConversationCommandArg(conversationManager, arg, cwd);
      if (!conversation) {
        logDebug(`contextOpenSessionNewTab failed to resolve conversation`);
        return;
      }
      logDebug(`contextOpenSessionNewTab resolved provider=${conversation.provider} id=${conversation.id} name=${conversation.name}`);
      const provider = conversationManager.getProvider(conversation.provider);
      if (!provider) {
        logDebug(`contextOpenSessionNewTab missing provider id=${conversation.provider}`);
        return;
      }
      await ensureProviderIntegrationReady(conversation.provider, true);
      await provider.openConversation(conversation, true);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.openSessionNewTab', async (arg: unknown, cwd?: string) => {
      const conversation = resolveConversationCommandArg(conversationManager, arg, cwd);
      if (!conversation) { return; }
      const provider = conversationManager.getProvider(conversation.provider);
      if (!provider) { return; }
      await ensureProviderIntegrationReady(conversation.provider, true);
      await provider.openConversation(conversation, true);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.deleteSession', async (item: any) => {
      const conversation = item?.conversation;
      if (!conversation) { return; }

      const label = truncate(conversation.name || conversation.id, 40);
      const confirm = await vscode.window.showWarningMessage(
        `Delete session "${label}"? This cannot be undone.`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') { return; }

      const provider = conversationManager.getProvider(conversation.provider);
      if (!provider) { return; }

      if (provider.deleteConversation(conversation.id)) {
        conversationManager.refresh();
        vscode.window.showInformationMessage('Session deleted.');
      } else {
        vscode.window.showWarningMessage('Session not found.');
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.renameSession', async (item: any) => {
      const conversation = item?.conversation;
      if (!conversation) { return; }

      const newName = await vscode.window.showInputBox({
        prompt: 'New session name',
        value: conversation.name,
        placeHolder: 'Enter new name',
      });
      if (!newName) { return; }

      const provider = conversationManager.getProvider(conversation.provider);
      if (!provider) { return; }

      if (provider.renameConversation(conversation.id, newName)) {
        conversationManager.refresh();
      } else {
        vscode.window.showWarningMessage('Failed to rename session.');
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.newSessionInProject', async (item: any) => {
      const cwd = item?.group?.cwd;
      if (!cwd) {
        vscode.window.showWarningMessage('Cannot determine project path.');
        return;
      }

      await runNewSessionFlow({
        treeProvider,
        providers,
        conversationManager,
        fixedProjectPath: cwd,
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.copyProjectPath', async (item: any) => {
      const targetPath = item?.group?.cwd;
      if (!targetPath) {
        vscode.window.showWarningMessage('Cannot determine project path.');
        return;
      }

      await vscode.env.clipboard.writeText(targetPath);
      vscode.window.showInformationMessage(`Copied: ${targetPath}`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.switchWorkspace', async (item: any) => {
      let targetPath: string | undefined;
      if (item?.conversation?.cwd) {
        targetPath = item.conversation.cwd;
      } else if (item?.group?.cwd) {
        targetPath = item.group.cwd;
      }

      if (!targetPath || !fs.existsSync(targetPath)) {
        vscode.window.showWarningMessage('Cannot determine project path.');
        return;
      }

      const targetUri = vscode.Uri.file(targetPath);
      const folders = vscode.workspace.workspaceFolders || [];

      if (folders.some(f => f.uri.fsPath === targetPath)) {
        vscode.window.showInformationMessage(`"${path.basename(targetPath)}" is already in the workspace.`);
        return;
      }

      const anchorPath = context.extensionPath;
      const anchorUri = vscode.Uri.file(anchorPath);
      const hasAnchor = folders.length > 0 && folders[0].uri.fsPath === anchorPath;

      if (folders.length === 0) {
        vscode.workspace.updateWorkspaceFolders(0, 0,
          { uri: anchorUri, name: '🎛 Vibe Control (anchor)' },
          { uri: targetUri },
        );
      } else if (!hasAnchor) {
        vscode.workspace.updateWorkspaceFolders(0, folders.length,
          { uri: anchorUri, name: '🎛 Vibe Control (anchor)' },
          { uri: targetUri },
        );
      } else {
        const removeCount = folders.length - 1;
        if (removeCount > 0) {
          vscode.workspace.updateWorkspaceFolders(1, removeCount, { uri: targetUri });
        } else {
          vscode.workspace.updateWorkspaceFolders(1, 0, { uri: targetUri });
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.refreshSessions', () => {
      conversationManager.refresh();
    }),
  );

  const config = vscode.workspace.getConfiguration('vibe-control');
  const enableHttp = config.get<boolean>('enableHttpServer', true);
  if (enableHttp) {
    const port = config.get<number>('httpPort', 23816);
    const version = String(context.extension.packageJSON.version || 'dev');
    void ensureDaemonRunning({
      extensionRoot: context.extensionPath,
      port,
      version,
    }).then((daemonPort) => {
      if (daemonPort) {
        console.log(`Vibe Control HTTP daemon running on http://127.0.0.1:${daemonPort}`);
        return;
      }

      const httpServer = new HttpServer(
        conversationManager,
        processManager,
        codexProcessManager,
        port,
        { mode: 'extension-fallback', version },
      );

      httpServer.start().then((actualPort) => {
        console.log(`Vibe Control HTTP API fallback running on http://127.0.0.1:${actualPort}`);
      }).catch((err) => {
        console.error('Vibe Control: Failed to start HTTP server fallback:', err.message);
      });

      context.subscriptions.push({
        dispose: () => {
          httpServer.dispose();
        },
      });
    }).catch((err) => {
      console.error('Vibe Control: Failed to ensure HTTP daemon:', err.message);
    });

    context.subscriptions.push({ dispose: () => processManager.dispose() });
  } else {
    context.subscriptions.push({ dispose: () => processManager.dispose() });
  }
}

function inferWorkingState(state: string | undefined, raw: unknown): string {
  if (state && state.trim().length > 0) {
    return state;
  }
  if (!raw || typeof raw !== 'object') {
    return 'unknown';
  }

  const record = raw as Record<string, unknown>;
  const direct = [
    readStringField(record, 'state'),
    readStringField(record, 'status'),
    readStringField(record, 'threadState'),
  ].find(Boolean);
  if (direct) {
    return direct;
  }

  const runtime = readObjectField(record, 'threadRuntimeStatus');
  const runtimeType = runtime ? readStringField(runtime, 'type') : undefined;
  const activeFlags = runtime && Array.isArray(runtime.activeFlags)
    ? runtime.activeFlags.filter((value): value is string => typeof value === 'string')
    : [];

  if (activeFlags.some(flag => /waitingon(userinput|approval)/i.test(flag))) {
    return 'waiting';
  }
  if (runtimeType === 'active') {
    return 'running';
  }
  if (runtimeType === 'systemError') {
    return 'failed';
  }

  const hasUnreadTurn = record.hasUnreadTurn === true;
  if (hasUnreadTurn) {
    return 'review';
  }

  return 'unknown';
}

async function pickProvider(providers: ConversationProvider[]): Promise<ConversationProvider | undefined> {
  const items = providers.map(provider => ({
    label: provider.label,
    description: providerDescription(provider),
    provider,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Choose a provider',
    ignoreFocusOut: true,
  });
  return picked?.provider;
}

async function pickProjectPath(): Promise<string | '' | null> {
  const choices: vscode.QuickPickItem[] = [
    { label: '$(folder) Current Workspace', description: 'Use current workspace path' },
    { label: '$(folder-opened) Choose Folder...', description: 'Select a different project folder' },
  ];
  const pick = await vscode.window.showQuickPick(choices, {
    placeHolder: 'Where should this session work?',
    ignoreFocusOut: true,
  });
  if (!pick) { return null; }

  if (pick.label.includes('Choose Folder')) {
    const uri = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Select Project Folder',
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    if (!uri || uri.length === 0) { return null; }
    return uri[0].fsPath;
  }

  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
}

async function promptForNewSession(
  treeProvider: SessionTreeProvider,
  providers: ConversationProvider[],
  fixedProjectPath?: string,
): Promise<{ provider: ConversationProvider; name: string; projectPath?: string | ''; } | null> {
  return treeProvider.runWithRefreshPaused(async () => {
    const provider = await pickProvider(providers);
    if (!provider) { return null; }

    const name = await vscode.window.showInputBox({
      prompt: 'Session name',
      placeHolder: 'e.g. Feature: Auth Refactor',
      ignoreFocusOut: true,
    });
    if (!name) { return null; }

    if (fixedProjectPath !== undefined) {
      return { provider, name, projectPath: fixedProjectPath };
    }

    const projectPath = await pickProjectPath();
    if (projectPath === null) { return null; }

    return { provider, name, projectPath };
  });
}

async function runNewSessionFlow({
  treeProvider,
  providers,
  conversationManager,
  fixedProjectPath,
}: {
  treeProvider: SessionTreeProvider;
  providers: ConversationProvider[];
  conversationManager: ConversationManager;
  fixedProjectPath?: string;
}): Promise<void> {
  const input = await promptForNewSession(treeProvider, providers, fixedProjectPath);
  if (!input) { return; }

  await input.provider.createConversation({
    name: input.name,
    projectPath: input.projectPath || undefined,
  });
  conversationManager.refresh();
}

function resolveConversation(
  conversationManager: ConversationManager,
  arg: string,
  cwd?: string,
  providerId?: ConversationRecord['provider'],
): ConversationRecord | null {
  return conversationManager.getConversationById(arg, providerId)
    || (cwd && providerId !== 'codex' ? {
      provider: 'claude',
      id: arg,
      name: arg,
      summary: arg,
      lastModified: 0,
      fileSize: 0,
      cwd,
      status: 'not_started',
    } : null);
}

function resolveConversationCommandArg(
  conversationManager: ConversationManager,
  arg: unknown,
  cwd?: string,
): ConversationRecord | null {
  if (typeof arg === 'string') {
    return resolveConversation(conversationManager, arg, cwd);
  }

  if (!arg || typeof arg !== 'object') {
    return null;
  }

  const record = arg as Record<string, unknown>;
  const nestedConversation = record.conversation;
  if (nestedConversation) {
    const resolvedNested = resolveConversationCommandArg(
      conversationManager,
      nestedConversation,
      cwd ?? readStringField(record, 'cwd'),
    );
    if (resolvedNested) {
      return resolvedNested;
    }
  }

  if (isConversationRecordLike(record)) {
    return record;
  }

  const legacySession = readObjectField(record, 'session');
  if (legacySession) {
    const legacySessionId = readStringField(legacySession, 'sessionId');
    if (legacySessionId) {
      return resolveConversation(
        conversationManager,
        legacySessionId,
        cwd ?? readStringField(legacySession, 'cwd'),
        'claude',
      );
    }
  }

  const conversationId = readStringField(record, 'id') || readStringField(record, 'sessionId');
  if (!conversationId) {
    return null;
  }

  const providerId = readProviderId(record, 'provider');
  return resolveConversation(
    conversationManager,
    conversationId,
    cwd ?? readStringField(record, 'cwd'),
    providerId,
  );
}

async function showSessionSearch(sessionIndexService: SessionIndexService): Promise<void> {
  const quickPick = vscode.window.createQuickPick<SearchSessionItem>();
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.placeholder = 'Search sessions by name, path, prompt, branch, provider, or ID';
  quickPick.buttons = [
    { iconPath: new vscode.ThemeIcon('go-to-search'), tooltip: 'Open Session Center' },
  ];

  const updateItems = () => {
    const sessions = sessionIndexService.searchSessions(quickPick.value);
    quickPick.items = sessions.slice(0, 50).map(toSearchItem);
  };

  updateItems();

  quickPick.onDidChangeValue(() => updateItems());
  quickPick.onDidTriggerButton(() => {
    void vscode.commands.executeCommand('vibe-control.showSessionCenter');
  });
  quickPick.onDidTriggerItemButton((event) => {
    const session = event.item.session;
    if (event.button.tooltip === 'Open in New Tab') {
      void vscode.commands.executeCommand('vibe-control.openSessionNewTab', session);
      return;
    }
    if (event.button.tooltip === 'Interrupt Session') {
      void vscode.commands.executeCommand('vibe-control.interruptSession', session);
      return;
    }
    if (event.button.tooltip === 'Stop Session') {
      void vscode.commands.executeCommand('vibe-control.stopSession', session);
    }
  });
  quickPick.onDidAccept(() => {
    const session = quickPick.selectedItems[0]?.session;
    if (session) {
      void vscode.commands.executeCommand('vibe-control.openSession', session);
    }
    quickPick.hide();
  });
  quickPick.onDidHide(() => quickPick.dispose());
  quickPick.show();
}

function describeCommandArg(arg: unknown): string {
  if (typeof arg === 'string') {
    return `string:${arg}`;
  }

  if (!arg || typeof arg !== 'object') {
    return typeof arg;
  }

  const record = arg as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  const conversation = readObjectField(record, 'conversation');
  const provider = readProviderId(record, 'provider') || (conversation ? readProviderId(conversation, 'provider') : undefined);
  const id = readStringField(record, 'id')
    || readStringField(record, 'sessionId')
    || (conversation ? readStringField(conversation, 'id') : undefined);

  return `object keys=${keys || '(none)'} provider=${provider ?? ''} id=${id ?? ''}`;
}

function isConversationRecordLike(value: unknown): value is ConversationRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  return isProviderId(record.provider)
    && typeof record.id === 'string'
    && typeof record.name === 'string'
    && typeof record.summary === 'string'
    && typeof record.status === 'string';
}

function isProviderId(value: unknown): value is ConversationRecord['provider'] {
  return value === 'claude' || value === 'codex';
}

function readProviderId(record: Record<string, unknown>, field: string): ConversationRecord['provider'] | undefined {
  const value = record[field];
  return isProviderId(value) ? value : undefined;
}

function readStringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readObjectField(record: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  const value = record[field];
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function waitForNewClaudeSessionAndRename(
  manager: SessionManager,
  title: string,
  onDiscovered?: (sessionId: string) => void,
): void {
  const projectsDir = manager.projectsDir;
  const existingIds = new Set<string>();

  if (fs.existsSync(projectsDir)) {
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const dir of dirs) {
      const files = fs.readdirSync(path.join(projectsDir, dir.name)).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        existingIds.add(file.slice(0, -6));
      }
    }
  }

  let attempts = 0;
  const interval = setInterval(() => {
    attempts++;
    if (attempts > 30) { clearInterval(interval); return; }

    if (!fs.existsSync(projectsDir)) { return; }
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const dir of dirs) {
      const files = fs.readdirSync(path.join(projectsDir, dir.name)).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const sessionId = file.slice(0, -6);
        if (!existingIds.has(sessionId)) {
          onDiscovered?.(sessionId);
          manager.renameSession(sessionId, title);
          manager.refresh();
          clearInterval(interval);
          return;
        }
      }
    }
  }, 500);
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) { return s; }
  return s.slice(0, maxLen - 3) + '...';
}

type EditorSelectionCapture = {
  filePath: string;
  relativePath: string;
  languageId: string;
  selectedText: string;
  lineRange: string;
};

type TerminalSelectionSourceKind = 'codex-cli' | 'claude-cli' | 'terminal';

type TerminalSelectionCapture = {
  terminalId?: string;
  title: string;
  cwd?: string;
  commandLine?: string;
  selectedText: string;
  sourceKind: TerminalSelectionSourceKind;
};

type CreateWorkspaceNoteOptions = {
  entity?: WorkspaceEntity;
  selection?: EditorSelectionCapture;
  terminalSelection?: TerminalSelectionCapture;
};

type WebviewSelectionPayload = {
  provider: 'claude' | 'codex';
  text: string;
  sessionId?: string;
  route?: string;
  title?: string;
  requestId?: string;
};

const WEBVIEW_SELECTION_TTL_MS = 5 * 60 * 1000;
let latestWebviewSelectionState: (WebviewSelectionPayload & { capturedAt: number }) | null = null;
let latestTerminalSelectionState: (TerminalSelectionCapture & { capturedAt: number }) | null = null;
let refreshSelectionStatusBar: (() => void) | null = null;
let refreshNotesView: (() => void) | null = null;
let workspaceEntityIndexServiceRef: WorkspaceEntityIndexService | null = null;
let terminalRegistryRef: TerminalRegistry | null = null;
let lastHandledWebviewSelectionToNoteKey: string | null = null;
let lastHandledWebviewSelectionToNoteAt = 0;

async function createWorkspaceNote(options: CreateWorkspaceNoteOptions = {}): Promise<void> {
  const basePath = resolveBasePathForEntity(options.entity)
    || resolveWorkspaceFolderForPath(options.selection?.filePath || '')
    || await pickNoteBasePath();
  if (!basePath) { return; }

  const suggestedTitle = defaultNoteTitleForSelection(options.selection) || defaultNoteTitleForEntity(options.entity);
  const selectionSuggestedTitle = defaultNoteTitleForSelection(options.selection)
    || defaultNoteTitleForTerminalSelection(options.terminalSelection)
    || defaultNoteTitleForEntity(options.entity);
  const title = await vscode.window.showInputBox({
    prompt: 'Note title',
    value: selectionSuggestedTitle,
    placeHolder: 'e.g. Review findings',
    ignoreFocusOut: true,
  });
  if (!title) { return; }

  const related = options.selection
    ? [toRelatedEntityFromSelection(options.selection)]
    : options.terminalSelection
      ? [toRelatedEntityFromTerminalSelection(options.terminalSelection)]
    : options.entity
      ? [toRelatedEntity(options.entity)]
      : [];
  const noteMeta: WorkspaceNoteMeta = {
    kind: 'note',
    title,
    related,
    template: options.entity || options.selection || options.terminalSelection ? 'capture' : 'blank',
    source: options.entity?.kind
      || (options.selection ? 'editor-selection' : options.terminalSelection ? `${options.terminalSelection.sourceKind}-selection` : 'manual'),
  };
  const body = buildNoteBody(title, options.entity, options.selection, options.terminalSelection);

  const notesDir = path.join(basePath, '.vibe-control', 'notes');
  fs.mkdirSync(notesDir, { recursive: true });
  const timestamp = formatFileTimestamp(new Date());
  const slug = slugify(title) || 'note';
  const filePath = path.join(notesDir, `${timestamp}-${slug}.md`);
  const content = buildWorkspaceArtifact(noteMeta, body);
  fs.writeFileSync(filePath, content, 'utf-8');

  const document = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(document, { preview: false });
  refreshNotesView?.();
}

async function addEditorSelectionToNote(): Promise<void> {
  const selection = captureEditorSelection();
  if (selection) {
    await createWorkspaceNote({ selection });
    return;
  }
  const webviewSelection = await requestCurrentWebviewSelection();
  if (webviewSelection && workspaceEntityIndexServiceRef) {
    await addWebviewSelectionToNote(webviewSelection, workspaceEntityIndexServiceRef);
    return;
  }
  const terminalSelection = await captureTerminalSelection();
  if (terminalSelection) {
    await createWorkspaceNote({ terminalSelection });
    return;
  }
  void vscode.window.showInformationMessage('Select some text in an editor tab or chat tab first.');
}

async function requestCurrentWebviewSelection(): Promise<WebviewSelectionPayload | null> {
  await ensureOfficialExtensionPatches(false);
  const commandIds = ['chatgpt.requestCurrentSelection', 'claude-vscode.requestCurrentSelection', 'claude-code.requestCurrentSelection'];

  for (const commandId of commandIds) {
    try {
      console.info(`Vibe Control Selection: request command=${commandId}`);
      logDebug(`selection request command=${commandId}`);
      const payload = await vscode.commands.executeCommand<WebviewSelectionPayload | null>(commandId);
      const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
      if (!payload) {
        console.info(`Vibe Control Selection: request command=${commandId} returned null`);
        logDebug(`selection request command=${commandId} returned null`);
        continue;
      }
      if (!payload.provider || !text) {
        console.info(`Vibe Control Selection: request command=${commandId} returned empty provider=${payload.provider ?? 'none'} rawLength=${typeof payload.text === 'string' ? payload.text.length : 0}`);
        logDebug(`selection request command=${commandId} returned empty provider=${payload.provider ?? 'none'} rawLength=${typeof payload.text === 'string' ? payload.text.length : 0}`);
        continue;
      }
      const nextPayload: WebviewSelectionPayload = {
        provider: payload.provider,
        text,
        sessionId: payload.sessionId,
        route: payload.route,
        title: payload.title,
      };
      console.info(`Vibe Control Selection: request command=${commandId} resolved provider=${nextPayload.provider} length=${nextPayload.text.length}`);
      logDebug(`selection request command=${commandId} resolved provider=${nextPayload.provider} length=${nextPayload.text.length}`);
      setLatestWebviewSelection(nextPayload);
      return nextPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.info(`Vibe Control Selection: request command=${commandId} failed error=${message}`);
      logDebug(`selection request command=${commandId} failed error=${message}`);
    }
  }

  return getLatestWebviewSelection();
}

async function captureTerminalSelection(): Promise<TerminalSelectionCapture | null> {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    return getLatestTerminalSelection();
  }

  const originalClipboard = await vscode.env.clipboard.readText();
  const sentinel = `__vibe_control_terminal_selection_${Date.now()}_${Math.random().toString(16).slice(2)}__`;

  try {
    await vscode.env.clipboard.writeText(sentinel);
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
    await delay(40);
    const selectedText = (await vscode.env.clipboard.readText()).trim();
    if (!selectedText || selectedText === sentinel) {
      return getLatestTerminalSelection();
    }

    const snapshot = terminalRegistryRef?.getSnapshotForTerminal(terminal);
    const selection: TerminalSelectionCapture = {
      terminalId: snapshot?.id,
      title: snapshot?.title || terminal.name,
      cwd: snapshot?.cwd,
      commandLine: snapshot?.commandLine,
      selectedText,
      sourceKind: classifyTerminalSelectionSource(snapshot?.title || terminal.name, snapshot?.commandLine),
    };
    setLatestTerminalSelection(selection);
    return selection;
  } catch {
    return getLatestTerminalSelection();
  } finally {
    try {
      await vscode.env.clipboard.writeText(originalClipboard);
    } catch {
      // Ignore clipboard restore failures.
    }
  }
}

function classifyTerminalSelectionSource(
  title: string | undefined,
  commandLine: string | undefined,
): TerminalSelectionSourceKind {
  const haystack = `${title || ''}\n${commandLine || ''}`.toLowerCase();
  if (haystack.includes('codex')) {
    return 'codex-cli';
  }
  if (haystack.includes('claude')) {
    return 'claude-cli';
  }
  return 'terminal';
}

function terminalSourceLabel(sourceKind: TerminalSelectionSourceKind): string {
  switch (sourceKind) {
    case 'codex-cli':
      return 'Codex CLI';
    case 'claude-cli':
      return 'Claude Code CLI';
    default:
      return 'Terminal';
  }
}

function buildTerminalSelectionContextLines(selection: TerminalSelectionCapture): string {
  return [
    `- Source: ${terminalSourceLabel(selection.sourceKind)}`,
    `- Title: ${selection.title}`,
    selection.terminalId ? `- Terminal ID: ${selection.terminalId}` : '',
    selection.cwd ? `- CWD: ${selection.cwd}` : '',
    selection.commandLine ? `- Command: ${selection.commandLine}` : '',
  ].filter(Boolean).join('\n');
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function appendEditorSelectionToExistingNote(note: NoteSnapshot): Promise<void> {
  const selection = captureEditorSelection();
  const webviewSelection = !selection ? await requestCurrentWebviewSelection() : null;
  const terminalSelection = !selection && !webviewSelection ? await captureTerminalSelection() : null;
  const webviewSessionEntity = webviewSelection && workspaceEntityIndexServiceRef
    ? resolveSessionEntityFromWebviewPayload(webviewSelection, workspaceEntityIndexServiceRef)
    : null;
  console.info(`Vibe Control Selection: append note=${note.title} editor=${selection ? 'yes' : 'no'} chat=${webviewSelection ? (webviewSelection.provider + ':' + webviewSelection.text.length) : 'no'} terminal=${terminalSelection ? (terminalSelection.sourceKind + ':' + terminalSelection.selectedText.length) : 'no'}`);
  logDebug(`selection append note=${note.title} editor=${selection ? 'yes' : 'no'} chat=${webviewSelection ? (webviewSelection.provider + ':' + webviewSelection.text.length) : 'no'} terminal=${terminalSelection ? (terminalSelection.sourceKind + ':' + terminalSelection.selectedText.length) : 'no'}`);
  if (!selection && !webviewSelection && !terminalSelection) {
    console.info('Vibe Control Selection: append failed no editor selection and no cached chat selection');
    logDebug('selection append failed no editor/chat/terminal selection');
    void vscode.window.showInformationMessage('Select some text in an editor tab, chat tab, or terminal first.');
    return;
  }
  if (!fs.existsSync(note.absolutePath)) {
    void vscode.window.showWarningMessage('Note file not found.');
    return;
  }

  const raw = fs.readFileSync(note.absolutePath, 'utf-8');
  const { meta, body } = parseWorkspaceArtifact<WorkspaceNoteMeta>(raw);
  const related = uniqueRelatedEntities([
    ...(Array.isArray(meta?.related) ? meta.related : note.related),
    ...(selection ? [toRelatedEntityFromSelection(selection)] : []),
    ...(webviewSelection ? [toRelatedEntityFromWebviewSelection(webviewSelection)] : []),
    ...(terminalSelection ? [toRelatedEntityFromTerminalSelection(terminalSelection)] : []),
  ]);
  const nextMeta: WorkspaceNoteMeta = {
    kind: 'note',
    title: meta?.title || note.title,
    related,
    template: meta?.template || 'capture',
    source: meta?.source || 'manual',
  };
  const nextBody = selection
    ? appendSelectionBlock(body, selection)
    : webviewSelection
      ? appendWebviewSelectionBlock(body, webviewSelection, webviewSessionEntity ?? undefined)
      : appendTerminalSelectionBlock(body, terminalSelection!);
  fs.writeFileSync(note.absolutePath, buildWorkspaceArtifact(nextMeta, nextBody), 'utf-8');
  if (webviewSelection) {
    clearLatestWebviewSelection();
  }
  if (terminalSelection) {
    clearLatestTerminalSelection();
  }

  const document = await vscode.workspace.openTextDocument(note.absolutePath);
  await vscode.window.showTextDocument(document, { preview: false });
  refreshNotesView?.();
}

function appendWebviewSelectionBlock(
  body: string,
  payload: WebviewSelectionPayload,
  entity?: WorkspaceEntity,
): string {
  const trimmedBody = body.trimEnd();
  const section = `## Added Chat Selection
${buildWebviewSelectionContextLines(payload, entity)}
\`\`\`text
${payload.text}
\`\`\``;
  return trimmedBody.length > 0 ? `${trimmedBody}

${section}
` : `${section}
`;
}

function appendTerminalSelectionBlock(body: string, selection: TerminalSelectionCapture): string {
  const trimmedBody = body.trimEnd();
  const section = `## Added Terminal Selection
${buildTerminalSelectionContextLines(selection)}
\`\`\`text
${selection.selectedText}
\`\`\``;
  return trimmedBody.length > 0 ? `${trimmedBody}

${section}
` : `${section}
`;
}

function appendSelectionBlock(body: string, selection: EditorSelectionCapture): string {
  const trimmedBody = body.trimEnd();
  const section = `## Added Selection
- File: ${selection.relativePath}
- Language: ${selection.languageId}
- Lines: ${selection.lineRange}

\`\`\`${selection.languageId || 'text'}
${selection.selectedText}
\`\`\``;
  return trimmedBody.length > 0 ? `${trimmedBody}

${section}
` : `${section}
`;
}

function toRelatedEntityFromWebviewSelection(payload: WebviewSelectionPayload): WorkspaceRelatedEntity {
  const sessionLabel = resolveWebviewSessionLabel(payload);
  const sessionId = payload.sessionId || extractConversationIdFromRoute(payload.route);
  return createRelatedEntity({
    kind: 'session',
    id: sessionId || payload.route || sessionLabel,
    title: sessionLabel,
    description: payload.route,
    provider: payload.provider,
  });
}

function toRelatedEntityFromTerminalSelection(selection: TerminalSelectionCapture): WorkspaceRelatedEntity {
  return createRelatedEntity({
    kind: 'terminal',
    id: selection.terminalId || `${selection.sourceKind}:${selection.title}`,
    title: selection.title,
    description: `${terminalSourceLabel(selection.sourceKind)}${selection.cwd ? ` · ${selection.cwd}` : ''}`,
    provider: selection.sourceKind === 'codex-cli' ? 'codex' : selection.sourceKind === 'claude-cli' ? 'claude' : undefined,
  });
}

function setLatestWebviewSelection(payload: WebviewSelectionPayload | null): void {
  const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    return;
  }
  latestWebviewSelectionState = { ...payload!, text, capturedAt: Date.now() };
  refreshSelectionStatusBar?.();
}

function setLatestTerminalSelection(selection: TerminalSelectionCapture | null): void {
  const text = typeof selection?.selectedText === 'string' ? selection.selectedText.trim() : '';
  if (!selection || !text) {
    return;
  }
  latestTerminalSelectionState = { ...selection, selectedText: text, capturedAt: Date.now() };
  refreshSelectionStatusBar?.();
}

function clearLatestWebviewSelection(): void {
  latestWebviewSelectionState = null;
  refreshSelectionStatusBar?.();
}

function clearLatestTerminalSelection(): void {
  latestTerminalSelectionState = null;
  refreshSelectionStatusBar?.();
}

function getLatestWebviewSelection(): WebviewSelectionPayload | null {
  if (!latestWebviewSelectionState) { return null; }
  if (Date.now() - latestWebviewSelectionState.capturedAt > WEBVIEW_SELECTION_TTL_MS) {
    latestWebviewSelectionState = null;
    return null;
  }
  return latestWebviewSelectionState;
}

function getLatestTerminalSelection(): TerminalSelectionCapture | null {
  if (!latestTerminalSelectionState) { return null; }
  if (Date.now() - latestTerminalSelectionState.capturedAt > WEBVIEW_SELECTION_TTL_MS) {
    latestTerminalSelectionState = null;
    return null;
  }
  return latestTerminalSelectionState;
}

function updateSelectionStatusBar(item: vscode.StatusBarItem): void {
  const editorSelection = captureEditorSelection();
  const webviewSelection = !editorSelection ? getLatestWebviewSelection() : null;
  const terminalSelection = !editorSelection && !webviewSelection ? getLatestTerminalSelection() : null;
  if (editorSelection) {
    item.text = '$(note) Selection Ready: Editor';
    item.tooltip = `Editor selection from ${editorSelection.relativePath} lines ${editorSelection.lineRange}`;
    item.show();
    return;
  }
  if (webviewSelection) {
    item.text = `$(comment-discussion) Selection Ready: ${webviewSelection.provider === 'claude' ? 'Claude' : 'Codex'}`;
    item.tooltip = webviewSelection.title
      ? `${webviewSelection.title}${webviewSelection.route ? `\n${webviewSelection.route}` : ''}`
      : webviewSelection.route || 'Chat selection cached';
    item.show();
    return;
  }
  if (terminalSelection) {
    item.text = `$(terminal) Selection Ready: ${terminalSourceLabel(terminalSelection.sourceKind)}`;
    item.tooltip = [
      terminalSelection.title,
      terminalSelection.cwd || '',
      terminalSelection.commandLine || '',
    ].filter(Boolean).join('\n');
    item.show();
    return;
  }
  item.hide();
}

async function addWebviewSelectionToNote(
  payload: WebviewSelectionPayload,
  workspaceEntityIndexService: WorkspaceEntityIndexService,
): Promise<void> {
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    return;
  }

  const sessionEntity = resolveSessionEntityFromWebviewPayload(payload, workspaceEntityIndexService);
  const basePath = resolveBasePathForEntity(sessionEntity ?? undefined) || await pickNoteBasePath();
  if (!basePath) { return; }

  const title = await vscode.window.showInputBox({
    prompt: 'Note title',
    value: defaultNoteTitleForWebviewPayload(payload, sessionEntity ?? undefined),
    placeHolder: 'e.g. Chat excerpt',
    ignoreFocusOut: true,
  });
  if (!title) { return; }

  const related = sessionEntity ? [toRelatedEntity(sessionEntity)] : [];
  const noteMeta: WorkspaceNoteMeta = {
    kind: 'note',
    title,
    related,
    template: 'capture',
    source: `${payload.provider}-webview-selection`,
  };
  const body = buildWebviewSelectionNoteBody(title, payload, text, sessionEntity ?? undefined);

  const notesDir = path.join(basePath, '.vibe-control', 'notes');
  fs.mkdirSync(notesDir, { recursive: true });
  const timestamp = formatFileTimestamp(new Date());
  const slug = slugify(title) || 'note';
  const filePath = path.join(notesDir, `${timestamp}-${slug}.md`);
  fs.writeFileSync(filePath, buildWorkspaceArtifact(noteMeta, body), 'utf-8');

  const document = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(document, { preview: false });
}

async function convertNoteToTaskDraft(note: NoteSnapshot): Promise<void> {
  if (!fs.existsSync(note.absolutePath)) {
    void vscode.window.showWarningMessage('Note file not found.');
    return;
  }

  const raw = fs.readFileSync(note.absolutePath, 'utf-8');
  const { meta, body } = parseWorkspaceArtifact<WorkspaceNoteMeta>(raw);
  const basePath = resolveWorkspaceFolderForPath(note.absolutePath) || await pickNoteBasePath();
  if (!basePath) { return; }

  const title = await vscode.window.showInputBox({
    prompt: 'Task draft title',
    value: note.title,
    placeHolder: 'e.g. Follow up task',
    ignoreFocusOut: true,
  });
  if (!title) { return; }

  const related = uniqueRelatedEntities([
    ...(Array.isArray(meta?.related) ? meta.related : note.related),
    createRelatedEntity({
      kind: 'note',
      id: note.id,
      title: note.title,
      description: note.relativePath,
      absolutePath: note.absolutePath,
    }),
  ]);

  const taskMeta: WorkspaceTaskDraftMeta = {
    kind: 'task-draft',
    title,
    related,
    draftStatus: 'todo',
    sourceNotePath: note.absolutePath,
  };
  const taskBody = `# ${title}

${body.trim() || note.excerpt}
`;

  const tasksDir = path.join(basePath, '.vibe-control', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const timestamp = formatFileTimestamp(new Date());
  const slug = slugify(title) || 'task';
  const filePath = path.join(tasksDir, `${timestamp}-${slug}.md`);
  fs.writeFileSync(filePath, buildWorkspaceArtifact(taskMeta, taskBody), 'utf-8');

  const document = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(document, { preview: false });
  refreshNotesView?.();
}

async function runSessionHandoffFlow(input: {
  sourceConversation: ConversationRecord;
  conversationManager: ConversationManager;
  sessionIndexService: SessionIndexService;
  sessionHandoffService: SessionHandoffService;
  refreshViews: () => void;
}): Promise<void> {
  const targetCandidates = input.sessionIndexService.listSessions()
    .filter(candidate => {
      return !(
        candidate.provider === input.sourceConversation.provider
        && candidate.id === input.sourceConversation.id
      );
    });

  const artifactChoice = await vscode.window.showQuickPick(
    [
      {
        label: 'Task Draft',
        description: 'Recommended',
        detail: 'Create a reusable handoff task draft under .vibe-control/tasks.',
        artifactKind: 'task-draft' as SessionHandoffArtifactKind,
      },
      {
        label: 'Note',
        description: 'Capture',
        detail: 'Create a handoff note under .vibe-control/notes.',
        artifactKind: 'note' as SessionHandoffArtifactKind,
      },
    ],
    {
      placeHolder: 'Choose the handoff artifact type',
      ignoreFocusOut: true,
    },
  );
  if (!artifactChoice) {
    return;
  }

  const relayChoice = await vscode.window.showQuickPick(
    [
      {
        label: 'Create Artifact Only',
        description: 'Recommended',
        relayToTarget: false,
      },
      ...(targetCandidates.length > 0
        ? [{
            label: 'Create Artifact And Relay To Another Session',
            description: `${targetCandidates.length} target sessions available`,
            relayToTarget: true,
          }]
        : []),
    ],
    {
      placeHolder: 'Choose how to use the handoff artifact',
      ignoreFocusOut: true,
    },
  );
  if (!relayChoice) {
    return;
  }

  let targetConversation: SessionSnapshot | null = null;
  if (relayChoice.relayToTarget) {
    const targetPick = await vscode.window.showQuickPick(
      targetCandidates.map(candidate => ({
        label: candidate.name,
        description: `${candidate.providerLabel} · ${candidate.projectLabel} · ${candidate.status}`,
        detail: candidate.cwd || candidate.resolvedId || candidate.id,
        candidate,
      })),
      {
        placeHolder: 'Choose the target session for the relay',
        ignoreFocusOut: true,
      },
    );
    if (!targetPick) {
      return;
    }
    targetConversation = targetPick.candidate;
  }

  const defaultTitle = buildDefaultSessionHandoffTitle(input.sourceConversation);
  const title = await vscode.window.showInputBox({
    prompt: 'Handoff artifact title',
    value: defaultTitle,
    placeHolder: 'e.g. Review handoff for follow-up implementation',
    ignoreFocusOut: true,
  });
  if (!title) {
    return;
  }

  const instructions = await vscode.window.showInputBox({
    prompt: 'Additional instructions for the next session (optional)',
    placeHolder: 'Leave blank to use the default continue-from-handoff instruction',
    ignoreFocusOut: true,
  });

  const request: CreateSessionHandoffInput = {
    sourceProvider: input.sourceConversation.provider,
    sourceSessionId: input.sourceConversation.id,
    artifactKind: artifactChoice.artifactKind,
    title,
    ...(typeof instructions === 'string' ? { instructions } : {}),
    ...(targetConversation
      ? {
          targetProvider: targetConversation.provider,
          targetSessionId: targetConversation.id,
          relayToTarget: true,
        }
      : {}),
  };

  try {
    const result = await input.sessionHandoffService.createHandoff(request);
    const document = await vscode.workspace.openTextDocument(result.artifactPath);
    await vscode.window.showTextDocument(document, { preview: false });
    input.refreshViews();
    void vscode.window.showInformationMessage(
      result.relayStarted
        ? `Handoff created and relayed: ${result.artifactPath}`
        : `Handoff created: ${result.artifactPath}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Failed to create session handoff: ${message}`);
  }
}

function buildDefaultSessionHandoffTitle(conversation: ConversationRecord): string {
  return `${conversation.name} handoff`;
}

async function pickNoteBasePath(): Promise<string | null> {
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  if (workspaceFolders.length === 1) {
    return workspaceFolders[0].uri.fsPath;
  }
  if (workspaceFolders.length > 1) {
    const picked = await vscode.window.showQuickPick(
      workspaceFolders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })),
      {
        placeHolder: 'Choose a workspace folder for the new note',
        ignoreFocusOut: true,
      },
    );
    return picked?.folder.uri.fsPath || null;
  }

  const uri = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Select Note Folder',
  });
  return uri?.[0]?.fsPath || null;
}

function resolveBasePathForEntity(entity: WorkspaceEntity | undefined): string | null {
  if (!entity) { return null; }
  switch (entity.kind) {
    case 'session':
      return entity.session.cwd || null;
    case 'terminal':
      return entity.terminal.cwd || null;
    case 'task':
      return (entity.task.absolutePath ? resolveWorkspaceFolderForPath(entity.task.absolutePath) : null) || pickFirstWorkspaceFolder();
    case 'note':
      return resolveWorkspaceFolderForPath(entity.note.absolutePath);
  }
}

function resolveWorkspaceFolderForPath(targetPath: string): string | null {
  for (const folder of vscode.workspace.workspaceFolders || []) {
    if (targetPath === folder.uri.fsPath || targetPath.startsWith(folder.uri.fsPath + path.sep)) {
      return folder.uri.fsPath;
    }
  }
  return null;
}

function pickFirstWorkspaceFolder(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
}

function defaultNoteTitleForSelection(selection: EditorSelectionCapture | undefined): string {
  if (!selection) { return ''; }
  return `Selection Note - ${path.basename(selection.filePath || selection.relativePath)}:${selection.lineRange}`;
}

function defaultNoteTitleForTerminalSelection(selection: TerminalSelectionCapture | undefined): string {
  if (!selection) { return ''; }
  return `${terminalSourceLabel(selection.sourceKind)} Selection Note - ${selection.title}`;
}

function defaultNoteTitleForEntity(entity: WorkspaceEntity | undefined): string {
  if (!entity) { return ''; }
  switch (entity.kind) {
    case 'session':
      return `Session Note - ${entity.title}`;
    case 'terminal':
      return `Terminal Note - ${entity.title}`;
    case 'task':
      return `Task Note - ${entity.title}`;
    case 'note':
      return entity.title;
  }
}

function buildNoteBody(
  title: string,
  entity: WorkspaceEntity | undefined,
  selection?: EditorSelectionCapture,
  terminalSelection?: TerminalSelectionCapture,
): string {
  const createdAt = new Date().toISOString();
  if (selection) {
    return `# ${title}

Created: ${createdAt}

## Source Selection
- File: ${selection.relativePath}
- Language: ${selection.languageId}
- Lines: ${selection.lineRange}

\`\`\`${selection.languageId || 'text'}
${selection.selectedText}
\`\`\`

## Notes

`;
  }
  if (terminalSelection) {
    return `# ${title}

Created: ${createdAt}

## Terminal Selection Context
${buildTerminalSelectionContextLines(terminalSelection)}

## Selected Text

\`\`\`text
${terminalSelection.selectedText}
\`\`\`

## Notes

`;
  }
  if (!entity) {
    return `# ${title}

Created: ${createdAt}

## Notes

`;
  }

  switch (entity.kind) {
    case 'session':
      return `# ${title}

Created: ${createdAt}

## Session Context
- Provider: ${entity.session.providerLabel}
- Project: ${entity.session.projectLabel}
- Status: ${entity.session.status}
- ID: ${entity.session.id}
- Path: ${entity.session.cwd || ''}

## Summary
${entity.session.summary || ''}

## First Prompt
${entity.session.firstPrompt || ''}

## Notes

`;
    case 'terminal':
      return `# ${title}

Created: ${createdAt}

## Terminal Context
- Title: ${entity.terminal.title}
- CWD: ${entity.terminal.cwd || ''}
- Command: ${entity.terminal.commandLine || ''}
- Status: ${entity.terminal.status}

## Recent Output

\`\`\`text
${entity.terminal.recentOutput || ''}
\`\`\`

## Notes

`;
    case 'task':
      return `# ${title}

Created: ${createdAt}

## Task Context
- Source: ${entity.task.source}
- Scope: ${entity.task.scope}
- Status: ${entity.task.taskType === 'draft' ? entity.task.draftStatus || 'todo' : entity.task.status}

## Requirement
${entity.task.requirement || ''}

## Notes

`;
    case 'note':
      return `# ${title}

Created: ${createdAt}

## Notes

`;
  }
}

function resolveSessionEntityFromWebviewPayload(
  payload: WebviewSelectionPayload,
  workspaceEntityIndexService: WorkspaceEntityIndexService,
): WorkspaceEntity | null {
  const sessionId = payload.sessionId || extractConversationIdFromRoute(payload.route);
  if (!sessionId) {
    return null;
  }
  return workspaceEntityIndexService
    .listEntities('session')
    .find(entity => entity.kind === 'session' && entity.provider === payload.provider && entity.id === sessionId) || null;
}

function extractConversationIdFromRoute(route: string | undefined): string | undefined {
  if (!route) { return undefined; }
  const match = route.match(/\/local\/([^/?#]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function defaultNoteTitleForWebviewPayload(payload: WebviewSelectionPayload, entity?: WorkspaceEntity): string {
  if (entity) {
    return `Selection Note - ${entity.title}`;
  }
  return `Selection Note - ${resolveWebviewSessionLabel(payload)}`;
}

function buildWebviewSelectionNoteBody(
  title: string,
  payload: WebviewSelectionPayload,
  text: string,
  entity?: WorkspaceEntity,
): string {
  const createdAt = new Date().toISOString();
  return `# ${title}

Created: ${createdAt}

## Source Session
${buildWebviewSelectionContextLines(payload, entity)}

## Selected Text

\`\`\`text
${text}
\`\`\`

## Notes

`;
}

function buildWebviewSelectionContextLines(
  payload: WebviewSelectionPayload,
  entity?: WorkspaceEntity,
): string {
  const sessionLabel = resolveWebviewSessionLabel(payload, entity);
  const sessionId = payload.sessionId || extractConversationIdFromRoute(payload.route);
  if (entity && entity.kind === 'session') {
    return [
      `- Provider: ${entity.session.providerLabel}`,
      `- Session: ${entity.title}`,
      `- Session ID: ${entity.session.id}`,
      `- Project: ${entity.session.projectLabel}`,
      `- Status: ${entity.session.status}`,
      entity.session.cwd ? `- Path: ${entity.session.cwd}` : '',
      entity.session.gitBranch ? `- Branch: ${entity.session.gitBranch}` : '',
      payload.route ? `- Route: ${payload.route}` : '',
      payload.title && payload.title !== entity.title ? `- Chat Title: ${payload.title}` : '',
    ].filter(Boolean).join('\n');
  }

  return [
    `- Provider: ${providerDisplayLabel(payload.provider)}`,
    `- Session: ${sessionLabel}`,
    sessionId ? `- Session ID: ${sessionId}` : '',
    payload.route && payload.route !== '/index.html' ? `- Route: ${payload.route}` : '',
  ].filter(Boolean).join('\n');
}

function resolveWebviewSessionLabel(
  payload: WebviewSelectionPayload,
  entity?: WorkspaceEntity,
): string {
  if (entity && entity.kind === 'session') {
    return entity.title;
  }

  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  if (title && !isGenericWebviewSessionTitle(title, payload.provider)) {
    return title;
  }

  const sessionId = payload.sessionId || extractConversationIdFromRoute(payload.route);
  if (sessionId) {
    return sessionId;
  }

  if (payload.route && payload.route !== '/index.html') {
    return payload.route;
  }

  return `${providerDisplayLabel(payload.provider)} Session`;
}

function isGenericWebviewSessionTitle(title: string, provider: WebviewSelectionPayload['provider']): boolean {
  const normalized = title.trim().toLowerCase();
  const genericTitles = new Set<string>([
    provider,
    providerDisplayLabel(provider).toLowerCase(),
    provider === 'claude' ? 'claude code' : 'codex',
    provider === 'claude' ? 'claude' : 'openai',
  ]);
  return genericTitles.has(normalized);
}

function providerDisplayLabel(provider: WebviewSelectionPayload['provider']): string {
  return provider === 'claude' ? 'Claude' : 'Codex';
}

function toRelatedEntityFromSelection(selection: EditorSelectionCapture): WorkspaceRelatedEntity {
  return createRelatedEntity({
    kind: 'document',
    id: selection.filePath,
    title: selection.relativePath,
    description: `${selection.languageId} · lines ${selection.lineRange}`,
    absolutePath: selection.filePath,
  });
}

function toRelatedEntity(entity: WorkspaceEntity): WorkspaceRelatedEntity {
  switch (entity.kind) {
    case 'session':
      return createRelatedEntity({
        kind: 'session',
        id: entity.id,
        title: entity.title,
        description: entity.description,
        provider: entity.provider,
      });
    case 'terminal':
      return createRelatedEntity({
        kind: 'terminal',
        id: entity.id,
        title: entity.title,
        description: entity.description,
      });
    case 'task':
      return createRelatedEntity({
        kind: 'task',
        id: entity.id,
        title: entity.title,
        description: entity.description,
        absolutePath: entity.task.absolutePath,
      });
    case 'note':
      return createRelatedEntity({
        kind: 'note',
        id: entity.id,
        title: entity.title,
        description: entity.description,
        absolutePath: entity.note.absolutePath,
      });
  }
}

function captureEditorSelection(): EditorSelectionCapture | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return null; }
  const selection = editor.selection;
  if (selection.isEmpty) { return null; }

  const selectedText = editor.document.getText(selection).trim();
  if (!selectedText) { return null; }

  const filePath = editor.document.uri.fsPath || editor.document.fileName;
  const workspaceRoot = filePath ? resolveWorkspaceFolderForPath(filePath) : null;
  const relativePath = workspaceRoot && filePath
    ? path.relative(workspaceRoot, filePath)
    : path.basename(filePath || editor.document.uri.toString());
  const startLine = selection.start.line + 1;
  const endLine = selection.end.line + 1;
  const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;

  return {
    filePath,
    relativePath,
    languageId: editor.document.languageId || 'text',
    selectedText,
    lineRange,
  };
}

function uniqueRelatedEntities(related: WorkspaceRelatedEntity[]): WorkspaceRelatedEntity[] {
  const result = new Map<string, WorkspaceRelatedEntity>();
  for (const item of related) {
    result.set(`${item.kind}:${item.id}`, item);
  }
  return Array.from(result.values());
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}


function normalizeNoteArg(arg: NoteSnapshot | { note?: NoteSnapshot } | undefined | null): NoteSnapshot | null {
  if (!arg) { return null; }
  if ((arg as NoteSnapshot).absolutePath) {
    return arg as NoteSnapshot;
  }
  const record = arg as { note?: NoteSnapshot };
  return record.note || null;
}

function formatFileTimestamp(date: Date): string {
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ];
  return `${parts[0]}${parts[1]}${parts[2]}-${parts[3]}${parts[4]}${parts[5]}`;
}

export function deactivate() {}

type SearchSessionItem = vscode.QuickPickItem & {
  session: SessionSnapshot;
};

function toSearchItem(session: SessionSnapshot): SearchSessionItem {
  const detailParts = [
    session.cwd,
    session.gitBranch ? `branch:${session.gitBranch}` : '',
    session.resolvedId ? `resolved:${session.resolvedId}` : '',
  ].filter(Boolean);

  const buttons: vscode.QuickInputButton[] = [
    { iconPath: new vscode.ThemeIcon('go-to-file'), tooltip: 'Open in New Tab' },
  ];
  if (session.isActive) {
    buttons.push(
      { iconPath: new vscode.ThemeIcon('debug-pause'), tooltip: 'Interrupt Session' },
      { iconPath: new vscode.ThemeIcon('debug-stop'), tooltip: 'Stop Session' },
    );
  }

  return {
    label: session.name,
    description: `${session.providerLabel} · ${session.projectLabel} · ${session.status}`,
    detail: detailParts.join(' · '),
    buttons,
    session,
  };
}
