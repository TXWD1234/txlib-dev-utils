import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CMakeToolsApi, getCMakeToolsApi, Version } from 'vscode-cmake-tools';

export type CMakeProject = NonNullable<Awaited<ReturnType<CMakeToolsApi['getProject']>>>;

class Engine {
	private config?: vscode.WorkspaceConfiguration;
	private cmakeApi?: CMakeToolsApi;
	private project?: CMakeProject;

	public static async projectExist() {
		const engine = new Engine();
		const initRes = await engine.init();
		if (initRes || !engine.project) {
			return false;
		}
		return true;
	}

	public static async run(log: vscode.OutputChannel) {		
		const engine = new Engine();
		const initRes = await engine.init();
		if (initRes) {
			log.appendLine(initRes);
			return false;
		}
		if(!await engine.acquireTargetCMakeProjectViaAsking(log)) { return false; }

		try {
			log.appendLine("[Status]: Starting CMake build...");
			const configureRes = await engine.project!.configureWithResult();
			if(configureRes.stdout) { log.appendLine(configureRes.stdout); }
			if(configureRes.stderr) { log.appendLine(configureRes.stderr); }
	    	const buildRes = await engine.project!.buildWithResult();
			if(buildRes.stdout) { log.appendLine(buildRes.stdout); }
			if(buildRes.stderr) { log.appendLine(buildRes.stderr); }
		    log.appendLine("[Status]: Build succeeded.");
		} catch (err: any) {
			log.appendLine(`[Error]: Failed to build project. ${err}`);
		    vscode.window.showErrorMessage(`TX: Failed to build project. Check CMake/Build output tab for detailed information.`);
			return false;
		}

		try {
			log.appendLine("[Status]: Starting Compilation Database Sync...");
			await engine.syncCompilationDatabaseWithTXLib(log);
			log.appendLine("[Status]: Sync succeeded.");
		} catch (err: any) {
			log.appendLine(`[Error]: Failed to sync compilation database with TXLib. ${err}`);
		    vscode.window.showErrorMessage(`TX: Failed to sync compilation database with TXLib.`);
			return false;
		}

		log.appendLine("");
		return true;
	}
	
	// return string when cannot proceed, undefined when success
	// I know this is not idiomatic, but this is already crap and I do not care
	// if it's good, so I reject your notion of propriety and revel in chaos
	private async init(): Promise<string | undefined> {
		this.config = vscode.workspace.getConfiguration('tx.devUtils');

		try {
			await this.acquireCMakeAPI();
		} catch (err) {
			return `[Error]: Failed to acquire CMake API instance. ${err}`;
		}

		try {
			await this.acquireTargetCMakeProject();
		} catch (err) {
			return `[Error]: Failed to acquire project source directory. ${err}`;
		}
		return undefined;
	}

	private async acquireCMakeAPI() {
	    const cmakeExt = vscode.extensions.getExtension('ms-vscode.cmake-tools');
	    if (!cmakeExt) {
	        vscode.window.showErrorMessage("TX: CMake Tools extension not found.");
	        throw new Error("CMake Tools extension not found.");
	    }

	    if (!cmakeExt.isActive) {
	        await cmakeExt.activate();
	    }

		this.cmakeApi = await getCMakeToolsApi(Version.v2);
		if(!this.cmakeApi) {
			throw new Error("Invalid CMake API instance.");
		}
	}

	private async acquireTargetCMakeProject() {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			throw new Error("No open workspace folders found.");
		}

		// Single folder workspace: no ambiguity
		if (folders.length === 1) {
			this.project = await this.cmakeApi?.getProject(folders[0].uri);
			if (!this.project) {
				throw new Error("Invalid project returned by CMake API");
			}
			return;
		}

		// Multi-root:
		const sourceDirectory = this.config?.get<string>("sourceDirectory");
		if (sourceDirectory && sourceDirectory.trim() !== '') {
			const sourceDirPath = Engine.resolvePath(sourceDirectory);
			if (!fs.existsSync(sourceDirPath)) { throw new Error(`${sourceDirPath} does not exist.`); }
			this.project = await this.cmakeApi?.getProject(vscode.Uri.file(sourceDirPath));
			if (!this.project) { throw new Error("Invalid project returned by CMake API"); }
		}
	}

	// I can feel my brain leaking from my ears writing this name
	private async acquireTargetCMakeProjectViaAsking(log: vscode.OutputChannel) {
		if (this.project) { return true; }
		const pickedFolder = await vscode.window.showWorkspaceFolderPick({
			placeHolder: "Select the CMake project folder to build and sync"
		});
		if (!pickedFolder) {
			// User cancelled the quick pick
			log.appendLine("[Status]: Declined by user.");
			return false;
		}

		this.project = await this.cmakeApi?.getProject(pickedFolder.uri);
		if (!this.project) {
			log.appendLine("[Error]: Invalid project instance returned by CMake API");
			return false;
		}

		// write picked folder to config
		await this.config?.update(
			'sourceDirectory',
			`\${workspaceFolder:${pickedFolder.name}}`,
			vscode.ConfigurationTarget.Workspace
		);
		return true;
	}

	private async syncCompilationDatabaseWithTXLib(log: vscode.OutputChannel) {
		const buildDir = await this.project!.getBuildDirectory();
		if (!buildDir) {
			log.appendLine("[Error]: Failed to acquire build directory from project.");
			throw new Error("Failed to acquire build directory from project.");
		}
		log.appendLine(`[Status]: Resolved CMake Build Dir:  ${buildDir}`);

		// compile_commands.json is guaranteed to be in buildDir
		// /path/to/compile_commands.json
		const srcPath = path.join(buildDir, 'compile_commands.json');

		const txlibPath = this.config!.get<string>('txlibPath');
		if (!txlibPath) {
			log.appendLine("[Error]: Failed to access config: txlibPath.");
			throw new Error("Failed to access config: txlibPath.");
		}
		const targetPath = path.join(
			Engine.resolvePath(txlibPath),
			"SampleProject/build/compile_commands.json");
		
		if(!fs.existsSync(srcPath)) { throw new Error(`${srcPath} does not exist.`); }

		fs.mkdirSync(path.dirname(targetPath), { recursive: true });
		fs.copyFileSync(srcPath, targetPath);
		log.appendLine(`[Status] Synced: ${srcPath} -> ${targetPath}`);
	}

	private static resolvePath(inputPath: string): string {
		if (!inputPath) {
			return '';
		}

		let resolved = inputPath;

		// 1. Expand ~/ or lone ~
		if (resolved === '~' || resolved.startsWith('~/')) {
			resolved = path.join(os.homedir(), resolved.slice(resolved.startsWith('~/') ? 2 : 1));
		}

		// 2. Expand ${userHome}
		resolved = resolved.replace(/\$\{userHome\}/g, os.homedir());

		// 3. Expand ${env:VAR_NAME}
		resolved = resolved.replace(/\$\{env:([^}]+)\}/g, (_, varName) => {
			return process.env[varName] ?? '';
		});

		// 4. Expand ${config:section.setting}
		resolved = resolved.replace(/\$\{config:([^}]+)\}/g, (_, settingKey) => {
			const parts = settingKey.split('.');
			const section = parts.shift()!;
			const key = parts.join('.');
			return vscode.workspace.getConfiguration(section).get<string>(key) ?? '';
		});

		// 5. Expand ${workspaceFolder:FolderName} (for multi-root workspaces)
		resolved = resolved.replace(/\$\{workspaceFolder:([^}]+)\}/g, (_, folderName) => {
			const matchedFolder = vscode.workspace.workspaceFolders?.find(f => f.name === folderName);
			return matchedFolder ? matchedFolder.uri.fsPath : '';
		});

		// 6. Expand generic ${workspaceFolder}
		resolved = resolved.replace(/\$\{workspaceFolder\}/g, () => {
			// Prefer the workspace folder of the active document, fallback to folder[0]
			const activeDoc = vscode.window.activeTextEditor?.document;
			if (activeDoc) {
				const activeFolder = vscode.workspace.getWorkspaceFolder(activeDoc.uri);
				if (activeFolder) {
					return activeFolder.uri.fsPath;
				}
			}
			return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
		});

		resolved = resolved.replace(/\$\{workspaceDefaultFolder\}/g, () => {
			return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
		});

		return path.resolve(resolved);
	}
};

class TXBuildPseudoterminal implements vscode.Pseudoterminal {
    private readonly writeEmitter =
        new vscode.EventEmitter<string>();

    private readonly closeEmitter =
        new vscode.EventEmitter<number | undefined>();

    public readonly onDidWrite = this.writeEmitter.event;
    public readonly onDidClose = this.closeEmitter.event;

    public open(): void {
        void this.run();
    }

    public close(): void {}

    private async run(): Promise<void> {
        try {
            this.writeEmitter.fire(
                'Starting TX build and sync...\r\n'
            );

            const succeeded =
                await vscode.commands.executeCommand<boolean>(
                    'txlib-dev-utils.cmakeBuildAndSync'
                );

            if (succeeded !== true) {
                this.writeEmitter.fire(
                    'TX build and sync failed.\r\n'
                );
                this.closeEmitter.fire(1);
                return;
            }

            this.writeEmitter.fire(
                'TX build and sync succeeded.\r\n'
            );
            this.closeEmitter.fire(0);
        } catch (err: unknown) {
            this.writeEmitter.fire(
                `Error: ${err instanceof Error ? err.message : String(err)}\r\n`
            );
            this.closeEmitter.fire(1);
        }
    }
}
class TXBuildTaskProvider implements vscode.TaskProvider {
    public static readonly TaskType = 'txlib-dev-utils';

    public provideTasks(): vscode.Task[] {
        const definition: vscode.TaskDefinition = {
            type: TXBuildTaskProvider.TaskType
        };

        return [
            new vscode.Task(
                definition,
                vscode.TaskScope.Workspace,
                'Build and Sync',
                'TX',
                new vscode.CustomExecution(async () => {
                    return new TXBuildPseudoterminal();
                })
            )
        ];
    }

    public resolveTask(task: vscode.Task): vscode.Task | undefined {
        return undefined;
    }
}

export async function activate(context: vscode.ExtensionContext) {
	const log = vscode.window.createOutputChannel("TXLib Dev Utils");
	context.subscriptions.push(log);

	const disposable = vscode.commands.registerCommand('txlib-dev-utils.cmakeBuildAndSync', async () => {
		log.show(false);
		return await Engine.run(log);
	});
	context.subscriptions.push(disposable);

	context.subscriptions.push(
	    vscode.tasks.registerTaskProvider(
	        TXBuildTaskProvider.TaskType,
	        new TXBuildTaskProvider()
	    )
	);

	const folders = vscode.workspace.workspaceFolders ?? [];
    const hasTXLib = folders.some(
        folder => folder.name === 'TXLib'
    );

	await vscode.commands.executeCommand(
        'setContext',
        'txlibDevUtils.enabled',
        hasTXLib && await Engine.projectExist()
    );
}

export function deactivate() {}
