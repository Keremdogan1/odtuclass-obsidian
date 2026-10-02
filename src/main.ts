import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from 'obsidian';

interface ODTUClassSettings {
	outputFolder: string;
	templateFolder: string;
}

const DEFAULT_SETTINGS: ODTUClassSettings = {
	outputFolder: 'ODTUClass/Assignments',
	templateFolder: 'ODTUClass/Templates'
}

export default class ODTUClassPlugin extends Plugin {
	settings: ODTUClassSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'process-pending-assignments',
			name: 'Process pending assignments',
			callback: () => {
				this.processPendingAssignments();
			}
		});

		this.addSettingTab(new ODTUClassSettingTab(this.app, this));
	}

	onunload() { }

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async processPendingAssignments() {
		const pendingDir = '.odtuclass/pending';
		
		const exists = await this.app.vault.adapter.exists(pendingDir);
		if (!exists) {
			new Notice('No pending ODTUClass assignments found (folder does not exist).');
			return;
		}

		const listed = await this.app.vault.adapter.list(pendingDir);
		const jsonFiles = listed.files.filter(f => f.endsWith('.json'));

		if (jsonFiles.length === 0) {
			new Notice('No pending ODTUClass assignments found.');
			return;
		}

		let processedCount = 0;

		// Ensure output folder exists (Vault API for normal folder)
		if (!this.app.vault.getAbstractFileByPath(this.settings.outputFolder)) {
			try {
				await this.createFolderRecursive(this.settings.outputFolder);
			} catch (e) {
				new Notice(`Failed to create output folder: ${this.settings.outputFolder}`);
				console.error(e);
				return;
			}
		}

		for (const filePath of jsonFiles) {
			try {
				const content = await this.app.vault.adapter.read(filePath);
				const assignment = JSON.parse(content);
				
				await this.processAssignment(assignment);
				
				// Delete pending file ONLY after successful creation (Adapter API)
				await this.app.vault.adapter.remove(filePath);
				processedCount++;
			} catch (error) {
				console.error(`Failed to process assignment file ${filePath}:`, error);
				new Notice(`Failed to process assignment: ${filePath}. Check console for details.`);
			}
		}

		if (processedCount > 0) {
			new Notice(`Successfully processed ${processedCount} assignment(s).`);
		}
	}

	async createFolderRecursive(path: string) {
		const parts = path.split('/');
		let currentPath = '';
		for (const part of parts) {
			if (!part) continue;
			currentPath = currentPath === '' ? part : `${currentPath}/${part}`;
			const folder = this.app.vault.getAbstractFileByPath(currentPath);
			if (!folder) {
				await this.app.vault.createFolder(currentPath);
			}
		}
	}

	async processAssignment(assignment: any) {
		const templateName = this.getTemplateNameForModuleType(assignment.moduleType);
		const templatePath = `${this.settings.templateFolder}/${templateName}.md`;
		
		const templateFile = this.app.vault.getAbstractFileByPath(templatePath);

		if (!templateFile || !(templateFile instanceof TFile)) {
			console.warn(`Template ${templatePath} not found for assignment ${assignment.id}.`);
			new Notice(`Template not found: ${templateName}.md`);
			throw new Error("TemplateNotFound"); // throw so it doesn't delete the JSON
		}

		const templateContent = await this.app.vault.read(templateFile);
		const renderedContent = this.renderTemplate(templateContent, assignment);
		
		const safeTitle = (assignment.title || 'Untitled').replace(/[\\/:*?"<>|]/g, '-');
		const safeId = assignment.id.replace(/[^a-zA-Z0-9.-]/g, '-');
		
		// Stable identity filename: "Title - ID.md"
		// This prevents creating (1), (2) for the exact same item.
		const outputPath = `${this.settings.outputFolder}/${safeTitle} - ${safeId}.md`;
		
		const existingFile = this.app.vault.getAbstractFileByPath(outputPath);
		if (existingFile && existingFile instanceof TFile) {
			// Overwrite the existing note with updated data
			await this.app.vault.modify(existingFile, renderedContent);
		} else {
			await this.app.vault.create(outputPath, renderedContent);
		}
	}

	getTemplateNameForModuleType(moduleType: string): string {
		switch (moduleType) {
			case 'assign':
			case 'turnitintooltwo':
				return 'Assignment';
			case 'quiz':
				return 'Quiz';
			case 'hvp':
			case 'h5pactivity':
				return 'Interactive';
			default:
				return 'Unknown';
		}
	}

	renderTemplate(template: string, data: any): string {
		let result = template;
		const placeholders = [
			'title', 'courseName', 'courseId', 'moduleId', 'moduleType', 
			'url', 'openAt', 'dueAt', 'closeAt'
		];

		for (const p of placeholders) {
			const value = data[p] !== null && data[p] !== undefined ? data[p] : '';
			const regex = new RegExp(`\\{\\{${p}\\}\\}`, 'g');
			result = result.replace(regex, String(value));
		}

		return result;
	}
}

class ODTUClassSettingTab extends PluginSettingTab {
	plugin: ODTUClassPlugin;

	constructor(app: App, plugin: ODTUClassPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();
		containerEl.createEl('h2', {text: 'ODTUClass Sync Settings'});

		new Setting(containerEl)
			.setName('Output folder')
			.setDesc('Folder where new assignments will be created (e.g. ODTUClass/Assignments)')
			.addText(text => text
				.setPlaceholder('ODTUClass/Assignments')
				.setValue(this.plugin.settings.outputFolder)
				.onChange(async (value) => {
					this.plugin.settings.outputFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Template folder')
			.setDesc('Folder where templates are stored (e.g. ODTUClass/Templates)')
			.addText(text => text
				.setPlaceholder('ODTUClass/Templates')
				.setValue(this.plugin.settings.templateFolder)
				.onChange(async (value) => {
					this.plugin.settings.templateFolder = value;
					await this.plugin.saveSettings();
				}));
	}
}
