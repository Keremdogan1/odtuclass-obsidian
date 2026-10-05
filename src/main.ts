import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from 'obsidian';
import { syncFromGithub } from './githubSync';

interface ODTUClassSettings {
	outputFolder: string;
	templateFolder: string;
	githubOwner: string;
	githubRepo: string;
	githubToken: string;
}

const DEFAULT_SETTINGS: ODTUClassSettings = {
	outputFolder: 'Projects/OdtüClass Tasks/_tasks',
	templateFolder: 'ODTUClass/Templates',
	githubOwner: 'Keremdogan1',
	githubRepo: 'odtuclass-sync',
	githubToken: ''
}

interface NormalizedDates {
	date: string;
	time: string;
}

export default class ODTUClassPlugin extends Plugin {
	settings: ODTUClassSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'sync-from-github',
			name: 'Sync from GitHub',
			callback: () => {
				syncFromGithub(this);
			}
		});

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

	async processAssignment(assignment: any, skipIfExists: boolean = false) {
		const templateName = assignment.type === 'section'
			? 'Section'
			: this.getTemplateNameForModuleType(assignment.moduleType);
		const templatePath = `${this.settings.templateFolder}/${templateName}.md`;
		
		const templateFile = this.app.vault.getAbstractFileByPath(templatePath);

		if (!templateFile || !(templateFile instanceof TFile)) {
			console.warn(`Template ${templatePath} not found for assignment ${assignment.id}.`);
			new Notice(`Template not found: ${templateName}.md`);
			throw new Error("TemplateNotFound");
		}

		const templateContent = await this.app.vault.read(templateFile);
		const renderedContent = this.renderTemplate(templateContent, assignment);
		
		const safeTitle = (assignment.title || 'Untitled').replace(/[\\/:*?"<>|]/g, '-');
		const safeId = assignment.id.replace(/[^a-zA-Z0-9.-]/g, '-');
		
		const outputPath = `${this.settings.outputFolder}/${safeTitle} - ${safeId}.md`;
		
		const existingFile = this.app.vault.getAbstractFileByPath(outputPath);
		if (existingFile && existingFile instanceof TFile) {
			if (assignment.type === 'section') {
				const existingContent = await this.app.vault.read(existingFile);

				const beginMarker = '<!-- ODTUCLASS:BEGIN -->';
				const endMarker = '<!-- ODTUCLASS:END -->';

				const beginIndex = existingContent.indexOf(beginMarker);
				const endIndex = existingContent.indexOf(endMarker);

				if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
					console.warn(
						`Section file ${outputPath} is missing valid ODTUCLASS markers. Skipping update.`
					);
					return;
				}

				const renderedBeginIndex = renderedContent.indexOf(beginMarker);
				const renderedEndIndex = renderedContent.indexOf(endMarker);

				if (
					renderedBeginIndex === -1 ||
					renderedEndIndex === -1 ||
					renderedEndIndex < renderedBeginIndex
				) {
					throw new Error(
						`Section template ${templatePath} is missing valid ODTUCLASS markers.`
					);
				}

				const managedContent = renderedContent.slice(
					renderedBeginIndex + beginMarker.length,
					renderedEndIndex
				);

				let updatedContent =
					existingContent.slice(0, beginIndex + beginMarker.length) +
					managedContent +
					existingContent.slice(endIndex);

				const hashRegex = /^(odtuclass-hash:\s*).*$/m;

				if (hashRegex.test(updatedContent)) {
					updatedContent = updatedContent.replace(
						hashRegex,
						`$1"${assignment.contentHash || ''}"`
					);
				}

				await this.app.vault.modify(existingFile, updatedContent);

				if (assignment.suggestedProblems && Array.isArray(assignment.suggestedProblems) && assignment.suggestedProblems.length > 0) {
					await this.processSubtasks(assignment, existingFile);
				}
				return;
			}

			if (skipIfExists) {
				return;
			}

			await this.app.vault.modify(existingFile, renderedContent);
		} else {
			const createdFile = await this.app.vault.create(outputPath, renderedContent);
			if (assignment.type === 'section' && assignment.suggestedProblems && Array.isArray(assignment.suggestedProblems) && assignment.suggestedProblems.length > 0) {
				await this.processSubtasks(assignment, createdFile);
			}
		}
	}

	async processSubtasks(assignment: any, parentFile: TFile) {
		const subtaskTemplatePath = `${this.settings.templateFolder}/Subtask.md`;
		const subtaskTemplateFile = this.app.vault.getAbstractFileByPath(subtaskTemplatePath);
		
		let subtaskTemplateContent = '';
		if (subtaskTemplateFile && subtaskTemplateFile instanceof TFile) {
			subtaskTemplateContent = await this.app.vault.read(subtaskTemplateFile);
		} else {
			subtaskTemplateContent = `---
pm-task: true
projectId: "[[OdtüClass Tasks|OdtüClass Tasks]]"
parentId: "[[{{parentFileName}}|{{parentTitle}}]]"
id: "{{id}}"
title: "{{title}}"
type: "subtask"
status: "todo"
priority: "medium"
due: "{{dueDate}}"
tags:
  - odtuclass
  - coursework
  - practice
---

Parent: [[{{parentFileName}}|{{parentTitle}}]]

## Suggested Problems (Ch. {{chapter}})

{{problemsList}}

## My Notes & Workspace

- [ ] 
`;
		}

		const parentBaseName = parentFile.basename;
		const parentTitle = assignment.title || parentBaseName;
		const subtaskRefs: Array<{ basename: string; title: string }> = [];

		for (const item of assignment.suggestedProblems) {
			const sectionNum = item.section;
			const topicTitle = item.title ? ` ${item.title}` : '';
			const subtaskTitle = `${sectionNum}${topicTitle} — Suggested Problems`;
			const subtaskId = `${assignment.id}:subtask:${sectionNum}`;
			const safeSubtaskTitle = subtaskTitle.replace(/[\\/:*?"<>|]/g, '-');
			const subtaskFileName = `${safeSubtaskTitle}.md`;
			const subtaskPath = `${this.settings.outputFolder}/${subtaskFileName}`;

			const problemsList = (item.problems || [])
				.map((p: string) => `- [ ] Problem ${p}`)
				.join('\n');

			const subtaskData: Record<string, any> = {
				id: subtaskId,
				title: subtaskTitle,
				parentFileName: parentBaseName,
				parentTitle: parentTitle,
				dueDate: assignment.weekEnd || '',
				chapter: sectionNum,
				problemsList: problemsList
			};

			let renderedSubtask = subtaskTemplateContent;
			for (const key of Object.keys(subtaskData)) {
				const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
				renderedSubtask = renderedSubtask.replace(regex, String(subtaskData[key] ?? ''));
			}

			const existingSubtask = this.app.vault.getAbstractFileByPath(subtaskPath);
			if (!existingSubtask) {
				await this.app.vault.create(subtaskPath, renderedSubtask);
			}

			subtaskRefs.push({
				basename: safeSubtaskTitle,
				title: subtaskTitle
			});
		}

		if (subtaskRefs.length > 0) {
			await this.linkSubtasksInParent(parentFile, subtaskRefs);
		}
	}

	async linkSubtasksInParent(parentFile: TFile, subtaskRefs: Array<{ basename: string; title: string }>) {
		let content = await this.app.vault.read(parentFile);

		const subtaskIdsYaml = subtaskRefs
			.map(r => `  - "[[${r.basename}|${r.title}]]"`)
			.join('\n');

		const subtaskIdsRegex = /^subtaskIds:\s*(\[\]|.*)$/m;
		if (subtaskIdsRegex.test(content)) {
			content = content.replace(subtaskIdsRegex, `subtaskIds:\n${subtaskIdsYaml}`);
		} else {
			content = content.replace(/^---\n([\s\S]*?)\n---/m, (match, p1) => {
				return `---\n${p1}\nsubtaskIds:\n${subtaskIdsYaml}\n---`;
			});
		}

		const subtasksBeginMarker = '<!-- ODTUCLASS:SUBTASKS:BEGIN -->';
		const subtasksEndMarker = '<!-- ODTUCLASS:SUBTASKS:END -->';

		const subtasksChecklist = subtaskRefs
			.map(r => {
				const isChecked = content.includes(`- [x] [[${r.basename}`);
				return `${isChecked ? '- [x]' : '- [ ]'} [[${r.basename}|${r.title}]]`;
			})
			.join('\n');

		const beginIdx = content.indexOf(subtasksBeginMarker);
		const endIdx = content.indexOf(subtasksEndMarker);

		if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
			content =
				content.slice(0, beginIdx + subtasksBeginMarker.length) +
				'\n' + subtasksChecklist + '\n' +
				content.slice(endIdx);
		} else {
			const myNotesHeader = '## My Notes & Workspace';
			const notesIdx = content.indexOf(myNotesHeader);
			const subtasksBlock = `\n## Subtasks\n\n${subtasksBeginMarker}\n${subtasksChecklist}\n${subtasksEndMarker}\n\n`;

			if (notesIdx !== -1) {
				content = content.slice(0, notesIdx) + subtasksBlock + content.slice(notesIdx);
			} else {
				content += subtasksBlock;
			}
		}

		await this.app.vault.modify(parentFile, content);
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

	formatOdtuclassDate(isoString: string | null | undefined): NormalizedDates {
		if (!isoString) {
			return { date: '', time: '' };
		}
		try {
			const dateObj = new Date(isoString);
			if (Number.isNaN(dateObj.getTime())) {
				return { date: '', time: '' };
			}
			const formatterDate = new Intl.DateTimeFormat('en-CA', {
				timeZone: 'Europe/Istanbul',
				year: 'numeric',
				month: '2-digit',
				day: '2-digit'
			});
			const formatterTime = new Intl.DateTimeFormat('en-GB', {
				timeZone: 'Europe/Istanbul',
				hour: '2-digit',
				minute: '2-digit',
				hour12: false
			});
			return { 
				date: formatterDate.format(dateObj), 
				time: formatterTime.format(dateObj) 
			};
		} catch (e) {
			console.warn("Invalid date format", isoString);
			return { date: '', time: '' };
		}
	}

	renderTemplate(template: string, assignment: any): string {
		const open = this.formatOdtuclassDate(assignment.openAt);
		const due = this.formatOdtuclassDate(assignment.dueAt);
		const close = this.formatOdtuclassDate(assignment.closeAt);

		// Extend data with V2 normalized placeholders while keeping all V1 fields
		const data = {
			...assignment,
			openDate: open.date,
			openTime: open.time,
			dueDate: due.date,
			dueTime: due.time,
			closeDate: close.date,
			closeTime: close.time
		};

		const placeholders = [
			'id', 'title', 'courseName', 'courseId', 'moduleId', 'moduleType', 'url',
			'openAt', 'dueAt', 'closeAt',
			'openDate', 'openTime', 'dueDate', 'dueTime', 'closeDate', 'closeTime',
			'sectionId', 'weekStart', 'weekEnd', 'content', 'contentHash'
		];

		let result = template;
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
			.setDesc('Folder where new assignments will be created (e.g. Projects/OdtüClass Tasks/_tasks)')
			.addText(text => text
				.setPlaceholder('Projects/OdtüClass Tasks/_tasks')
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

		containerEl.createEl('h3', {text: 'GitHub Sync'});

		new Setting(containerEl)
			.setName('GitHub Owner')
			.setDesc('GitHub username or organization (e.g. Keremdogan1)')
			.addText(text => text
				.setPlaceholder('Keremdogan1')
				.setValue(this.plugin.settings.githubOwner)
				.onChange(async (value) => {
					this.plugin.settings.githubOwner = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('GitHub Repository')
			.setDesc('GitHub repository name (e.g. odtuclass-sync)')
			.addText(text => text
				.setPlaceholder('odtuclass-sync')
				.setValue(this.plugin.settings.githubRepo)
				.onChange(async (value) => {
					this.plugin.settings.githubRepo = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('GitHub Token (Fine-grained PAT)')
			.setDesc('Token with Contents: Read-only access to the sync repository')
			.addText(text => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('github_pat_...')
					.setValue(this.plugin.settings.githubToken)
					.onChange(async (value) => {
						this.plugin.settings.githubToken = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Sync from GitHub')
			.setDesc('Manually trigger a sync from the configured GitHub repository')
			.addButton(button => button
				.setButtonText('Sync ODTUClass')
				.setCta()
				.onClick(() => {
					syncFromGithub(this.plugin);
				}));
	}
}
