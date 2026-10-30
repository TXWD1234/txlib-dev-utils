import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CMakeToolsApi, getCMakeToolsApi, Version } from 'vscode-cmake-tools';

export type CMakeProject = NonNullable<Awaited<ReturnType<CMakeToolsApi['getProject']>>>;

class Engine {
	private config?: vscode.WorkspaceConfiguration;
	private cmakeApi?: CMakeToolsApi;
	private projectSourceDir?: vscode.Uri;

	public static async projectExist() {
		const engine = new Engine();
		const initRes = await engine.init();
		if (initRes || !await engine.checkTargetCMakeProjectValidity()) { return false; }
		return true;
	}

	public static async acquireCompilationDatabasePath(): Promise<string> {
		const config = vscode.workspace.getConfiguration('tx.devUtils');
		if(!config) {
			throw new Error("Failed to acquire config instance.");
		}

		const txlibPath = config.get<string>('txlibPath');
		if (!txlibPath) {
			throw new Error("Failed to access config: txlibPath.");
		}
	
		return path.join(
			Engine.resolvePath(txlibPath),
			"SampleProject/build");
	}

	public static async run(log: vscode.OutputChannel) {		
		const engine = new Engine();
		const initRes = await engine.init();
		if (initRes) {
			log.appendLine(initRes);
			return false;
		}
		if (!await engine.acquireTargetCMakeProjectViaAsking(log)) { return false; }
		if (!await engine.checkTargetCMakeProjectValidity()) { return false; }

		let success = true;

		try {
			log.appendLine("[Status]: Starting CMake build...");
			await engine.focusCMakeOutputChannel();

			const project = await engine.cmakeApi!.getProject(engine.projectSourceDir!);
			
			const configureRes = await project!.configureWithResult();
			if (configureRes.stdout) { log.appendLine(configureRes.stdout); }
	    	if (configureRes.exitCode !== 0) { return engine.buildFailed(log, configureRes.stderr); }
			
			const buildRes = await project!.buildWithResult();
			if (buildRes.stdout) { log.appendLine(buildRes.stdout); }
	    	if (buildRes.exitCode !== 0) { return engine.buildFailed(log, buildRes.stderr); }

        	// const exitCode = await vscode.commands.executeCommand<number>(
			// 	'cmake.build', undefined, false, engine.projectSourceDir);
        	// if (exitCode !== 0 && exitCode !== undefined) {
		    // 	log.appendLine(`[Error]: Build failed with exit code ${exitCode}.`);
		    // 	vscode.window.showErrorMessage(`TX: Failed to build project. Check CMake/Build output tab for detailed information.`);
			// 	return false;
        	// }
		    log.appendLine("[Status]: Build succeeded.");
		} catch (err: any) {
			return engine.buildFailed(log, err);
		}

		try {
			log.appendLine("[Status]: Starting Compilation Database Sync...");
			await engine.syncCompilationDatabaseWithTXLib(log);
			log.appendLine("[Status]: Sync succeeded.");
			success = true;
		} catch (err: any) {
			log.appendLine(`[Error]: Failed to sync compilation database with TXLib. ${err}`);
		    vscode.window.showErrorMessage(`TX: Failed to sync compilation database with TXLib.`);
			success = false;
		}

		log.appendLine("");
		log.show(false);
		return success;
	}
	private buildFailed(log: vscode.OutputChannel, err: string | undefined) {
		log.appendLine(`[Error]: Failed to build project. \n${err}`);
		vscode.window.showErrorMessage(`TX: Failed to build project. Check CMake/Build output tab for detailed information.`);
		return false;
	}
	private async focusCMakeOutputChannel(): Promise<void> {
		try {
			// Query all registered internal commands
			const allCommands = await vscode.commands.getCommands(true);

			// Find the command that reveals the CMake Tools output channel
			const cmakeOutputCmd = allCommands.find(cmd => 
				cmd.startsWith('workbench.action.output.show.extension-output-ms-vscode.cmake-tools')
			);

			if (cmakeOutputCmd) {
				await vscode.commands.executeCommand(cmakeOutputCmd);
			}
		} catch {}
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
			this.projectSourceDir = folders[0].uri;
			return;
		}

		// Multi-root:
		const sourceDirectory = this.config?.get<string>("sourceDirectory");
		if (sourceDirectory && sourceDirectory.trim() !== '') {
			const sourceDirPath = Engine.resolvePath(sourceDirectory);
			if (!fs.existsSync(sourceDirPath)) { throw new Error(`${sourceDirPath} does not exist.`); }
			this.projectSourceDir = vscode.Uri.file(sourceDirPath);
		}
	}

	// I can feel my brain leaking from my ears writing this name
	private async acquireTargetCMakeProjectViaAsking(log: vscode.OutputChannel) {
		if (await this.checkTargetCMakeProjectValidity()) { return true; }
		const pickedFolder = await vscode.window.showWorkspaceFolderPick({
			placeHolder: "Select the CMake project folder to build and sync"
		});
		if (!pickedFolder) {
			// User cancelled the quick pick
			log.appendLine("[Status]: Declined by user.");
			return false;
		}

		this.projectSourceDir = pickedFolder.uri;

		// write picked folder to config
		await this.config?.update(
			'sourceDirectory',
			`\${workspaceFolder:${pickedFolder.name}}`,
			vscode.ConfigurationTarget.Workspace
		);
		return true;
	}

	private async checkTargetCMakeProjectValidity(): Promise<boolean> {
		if (!this.projectSourceDir) { return false; }
		if (!await this.cmakeApi!.getProject(this.projectSourceDir)) { return false; }
		return true;
	}

	private async syncCompilationDatabaseWithTXLib(log: vscode.OutputChannel) {
		const buildDir = await (await this.cmakeApi!.getProject(this.projectSourceDir!))!.getBuildDirectory();
		if (!buildDir) {
			log.appendLine("[Error]: Failed to acquire build directory from project.");
			throw new Error("Failed to acquire build directory from project.");
		}
		log.appendLine(`[Status]: Resolved CMake Build Dir:  ${buildDir}`);

		// compile_commands.json is guaranteed to be in buildDir
		// /path/to/compile_commands.json
		const srcPath = path.join(buildDir, 'compile_commands.json');
		if (!fs.existsSync(srcPath)) { throw new Error(`${srcPath} does not exist.`); }

		const targetPath = path.join(
			await Engine.acquireCompilationDatabasePath(),
			"compile_commands.json");

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

	const cmakeBuildAndSync = vscode.commands.registerCommand('txlib-dev-utils.cmakeBuildAndSync', async () => {
		log.show(false);
		return await Engine.run(log);
	});
	context.subscriptions.push(cmakeBuildAndSync);

	const clearCompilationDatabase = vscode.commands.registerCommand('txlib-dev-utils.clearCompilationDatabase', async () => {
		try {
			fs.rmSync(await Engine.acquireCompilationDatabasePath(), { recursive: true, force: true });
			log.appendLine(`[Status]: Successfully cleared TXLib compilation database.`);
		} catch (err: any) {
			log.appendLine(`[Error]: Failed to clear compilation database. ${err}`);
			vscode.window.showErrorMessage(`TX: Failed to clear compilation database.`);
		}
		log.appendLine("");
	});
	context.subscriptions.push(clearCompilationDatabase);

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
