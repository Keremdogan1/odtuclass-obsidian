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

	cleanItemTitle(rawTitle: string, courseName: string, isSection: boolean, item?: any): string {
		let clean = (rawTitle || 'Untitled').trim();

		// 1. Strip exact courseName if title starts with it
		if (courseName && clean.startsWith(courseName)) {
			clean = clean.slice(courseName.length).replace(/^[\s—–-]+/, '').trim();
		}

		// 2. Strip bracketed course prefix, e.g. "[ENG 101 Section 119] ... — "
		clean = clean.replace(/^\[.*?\]\s*[^—–-]*[—–-]\s*/, '').trim();

		// 3. Strip standalone bracket prefix like "[MATH 119 All Sections] "
		clean = clean.replace(/^\[.*?\]\s*/, '').trim();

		if (isSection) {
			// Check if clean title is a date range like "September 28 - October 4"
			const dateMatch = clean.match(/([a-zA-Z]+)\s+(\d{1,2})\s*[-–—]\s*(?:([a-zA-Z]+)\s+)?(\d{1,2})/);
			if (dateMatch && (clean === dateMatch[0] || clean.length <= dateMatch[0].length + 5)) {
				const secNum = item?.sectionNumber || (item?.weekNumber !== undefined ? item.weekNumber : null);
				const topic = this.extractTopicFromSectionContent(item?.content);
				if (secNum && topic) {
					return `Week ${secNum}: ${topic}`;
				} else if (topic) {
					return topic;
				} else if (secNum) {
					return `Week ${secNum}`;
				}
			}
		}

		return clean || rawTitle;
	}

	extractTopicFromSectionContent(content?: string): string | null {
		if (!content || typeof content !== 'string') return null;
		const chMatch = content.match(/(?:^|\n)\s*Ch\.\s*\d+:\s*([^\n\r]+)/i);
		if (chMatch) {
			return chMatch[1].trim();
		}
		const topicsMatch = content.match(/(?:^|\n)\s*Topics to be covered:?\s*\n+([\s\S]*?)(?=\n\s*(?:Suggested problems|Reading assignment|[-*]\s*\d+\.\d+:|$))/i);
		if (topicsMatch) {
			const lines = topicsMatch[1]
				.split('\n')
				.map(l => l.replace(/^\s*\d+\.\d+\.?\s*/, '').replace(/\s+and\s+Infinite\s+Limits/i, '').trim())
				.filter(l => l.length > 0 && !l.startsWith('-'));
			if (lines.length > 0) {
				if (lines.length <= 2) {
					return lines.join(' & ');
				}
				return `${lines[0]} & ${lines[1]}`;
			}
		}
		return null;
	}

	async getOrCreateCourseTask(courseId: string | number, courseName: string): Promise<{ file: TFile; basename: string; title: string }> {
		const courseIdStr = String(courseId);

		// 1. Search in outputFolder
		const folder = this.app.vault.getAbstractFileByPath(this.settings.outputFolder);
		if (folder && folder instanceof TFolder) {
			for (const child of folder.children) {
				if (child instanceof TFile && child.extension === 'md') {
					const cache = this.app.metadataCache.getFileCache(child);
					const fm = cache?.frontmatter;
					if (fm) {
						if (fm.id === `course:${courseIdStr}` || 
							String(fm['odtuclass-course-id']) === courseIdStr ||
							(fm['pm-task'] === true && fm.type === 'task' && fm.title === courseName)) {
							return {
								file: child,
								basename: child.basename,
								title: fm.title || courseName
							};
						}
					}
				}
			}
		}

		// 2. Compute clean filename
		let cleanCourseName = courseName;
		const bracketMatch = courseName.match(/^\[(.*?)\]\s*(.*)$/);
		if (bracketMatch) {
			const codePart = bracketMatch[1].replace(/\s+All Sections/i, '').trim();
			const titlePart = bracketMatch[2].trim();
			cleanCourseName = `${codePart} - ${titlePart}`;
		}
		const safeBase = cleanCourseName.replace(/[\\/:*?"<>|]/g, '-').trim();
		const coursePath = `${this.settings.outputFolder}/${safeBase}.md`;

		let courseFile = this.app.vault.getAbstractFileByPath(coursePath);
		if (!courseFile || !(courseFile instanceof TFile)) {
			const content = `---
pm-task: true
projectId: "[[OdtüClass Tasks|OdtüClass Tasks]]"
id: "course:${courseIdStr}"
title: "${courseName}"
type: "task"
status: "in-progress"
priority: "medium"
due: ""
tags:
  - odtuclass
  - course
subtaskIds: []
odtuclass-course-id: "${courseIdStr}"
odtuclass-course: "${courseName}"
---

# ${courseName}

**Platform:** ODTUClass  

## Subtasks

<!-- ODTUCLASS:SUBTASKS:BEGIN -->
<!-- ODTUCLASS:SUBTASKS:END -->

## Course Notes & Workspace

- [ ] 
`;
			courseFile = await this.app.vault.create(coursePath, content);
			await this.registerCourseInProject(safeBase, courseName);
		}

		return {
			file: courseFile as TFile,
			basename: (courseFile as TFile).basename,
			title: courseName
		};
	}

	async registerCourseInProject(courseBasename: string, courseTitle: string) {
		const projectPath = 'Projects/OdtüClass Tasks/OdtüClass Tasks.md';
		const projectFile = this.app.vault.getAbstractFileByPath(projectPath);
		if (!projectFile || !(projectFile instanceof TFile)) return;

		let content = await this.app.vault.read(projectFile);
		const courseLink = `[[${courseBasename}|${courseTitle}]]`;

		if (!content.includes(`[[${courseBasename}`)) {
			const taskIdsRegex = /^taskIds:\s*(\[[\s\S]*?\])/m;
			const taskIdsMatch = content.match(taskIdsRegex);
			if (taskIdsMatch) {
				try {
					const existingArray = JSON.parse(taskIdsMatch[1]);
					if (Array.isArray(existingArray)) {
						existingArray.push(courseLink);
						content = content.replace(taskIdsRegex, `taskIds: ${JSON.stringify(existingArray)}`);
					}
				} catch (e) {
					content = content.replace(taskIdsRegex, (match, p1) => {
						const trimmed = p1.trim().replace(/\]$/, '');
						return `taskIds: ${trimmed}, "${courseLink}"]`;
					});
				}
			}

			if (!content.includes(`- [ ] [[${courseBasename}`) && !content.includes(`- [x] [[${courseBasename}`)) {
				const tasksHeaderRegex = /(## Tasks\s*\n)/;
				if (tasksHeaderRegex.test(content)) {
					content = content.replace(tasksHeaderRegex, `$1- [ ] ${courseLink}\n`);
				}
			}

			await this.app.vault.modify(projectFile, content);
		}
	}

	async linkChildToParent(parentFile: TFile, childRef: { basename: string; title: string }) {
		let content = await this.app.vault.read(parentFile);
		const childLink = `[[${childRef.basename}|${childRef.title}]]`;
		const childEntryYaml = `  - "${childLink}"`;

		let changed = false;

		// 1. Update subtaskIds in frontmatter
		if (!content.includes(`[[${childRef.basename}`)) {
			const subtaskIdsRegex = /^subtaskIds:\s*(\[\]|.*)$/m;
			if (subtaskIdsRegex.test(content)) {
				const currentMatch = content.match(subtaskIdsRegex);
				if (currentMatch && currentMatch[1].trim() === '[]') {
					content = content.replace(subtaskIdsRegex, `subtaskIds:\n${childEntryYaml}`);
				} else {
					content = content.replace(/^subtaskIds:\s*\n?/m, `subtaskIds:\n${childEntryYaml}\n`);
				}
			} else {
				content = content.replace(/^---\n([\s\S]*?)\n---/m, (match, p1) => {
					return `---\n${p1}\nsubtaskIds:\n${childEntryYaml}\n---`;
				});
			}
			changed = true;
		}

		// 2. Update Subtasks checklist in body
		const subtasksBeginMarker = '<!-- ODTUCLASS:SUBTASKS:BEGIN -->';
		const subtasksEndMarker = '<!-- ODTUCLASS:SUBTASKS:END -->';

		const beginIdx = content.indexOf(subtasksBeginMarker);
		const endIdx = content.indexOf(subtasksEndMarker);

		if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
			const existingBlock = content.slice(beginIdx + subtasksBeginMarker.length, endIdx);
			if (!existingBlock.includes(`[[${childRef.basename}`)) {
				const newBlock = existingBlock.trimEnd() + `\n- [ ] ${childLink}\n`;
				content = content.slice(0, beginIdx + subtasksBeginMarker.length) +
					'\n' + newBlock.trim() + '\n' +
					content.slice(endIdx);
				changed = true;
			}
		} else {
			const subtasksHeader = '## Subtasks';
			const headerIdx = content.indexOf(subtasksHeader);
			if (headerIdx !== -1) {
				const afterHeader = content.slice(headerIdx + subtasksHeader.length);
				if (!afterHeader.includes(`[[${childRef.basename}`)) {
					const nextSectionMatch = afterHeader.search(/\n##\s+/);
					const insertPoint = nextSectionMatch !== -1 ? headerIdx + subtasksHeader.length + nextSectionMatch : content.length;
					const newSubtaskLine = `\n\n- [ ] ${childLink}`;
					content = content.slice(0, insertPoint) + newSubtaskLine + content.slice(insertPoint);
					changed = true;
				}
			} else {
				const notesHeader = '## ';
				const notesIdx = content.indexOf(notesHeader);
				const subtaskBlock = `\n## Subtasks\n\n${subtasksBeginMarker}\n- [ ] ${childLink}\n${subtasksEndMarker}\n\n`;
				if (notesIdx !== -1) {
					content = content.slice(0, notesIdx) + subtaskBlock + content.slice(notesIdx);
				} else {
					content += subtaskBlock;
				}
				changed = true;
			}
		}

		if (changed) {
			await this.app.vault.modify(parentFile, content);
		}
	}

	async processAssignment(assignment: any, skipIfExists: boolean = false) {
		const courseTask = await this.getOrCreateCourseTask(assignment.courseId, assignment.courseName);

		const isSection = assignment.type === 'section';
		const cleanTitle = this.cleanItemTitle(assignment.title, assignment.courseName, isSection, assignment);

		const templateName = isSection
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
		const renderedContent = this.renderTemplate(templateContent, assignment, {
			parentFileName: courseTask.basename,
			parentTitle: courseTask.title,
			cleanTitle: cleanTitle
		});
		
		const safeTitle = cleanTitle.replace(/[\\/:*?"<>|]/g, '-').trim();
		const safeId = assignment.id.replace(/[^a-zA-Z0-9.-]/g, '-');
		
		const outputPath = `${this.settings.outputFolder}/${safeTitle} - ${safeId}.md`;
		
		// Find existing file either by exact outputPath or by ID in filename / frontmatter
		let existingFile: TFile | null = null;
		const directFile = this.app.vault.getAbstractFileByPath(outputPath);
		if (directFile && directFile instanceof TFile) {
			existingFile = directFile;
		} else {
			const folder = this.app.vault.getAbstractFileByPath(this.settings.outputFolder);
			if (folder && folder instanceof TFolder) {
				for (const child of folder.children) {
					if (child instanceof TFile && child.extension === 'md') {
						if (child.basename.endsWith(`- ${safeId}`)) {
							existingFile = child;
							break;
						}
						const cache = this.app.metadataCache.getFileCache(child);
						if (cache?.frontmatter?.id === assignment.id) {
							existingFile = child;
							break;
						}
					}
				}
			}
		}

		let targetFile: TFile;

		if (existingFile) {
			targetFile = existingFile;
			if (isSection) {
				const existingContent = await this.app.vault.read(existingFile);

				const beginMarker = '<!-- ODTUCLASS:BEGIN -->';
				const endMarker = '<!-- ODTUCLASS:END -->';

				const beginIndex = existingContent.indexOf(beginMarker);
				const endIndex = existingContent.indexOf(endMarker);

				if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
					console.warn(
						`Section file ${existingFile.path} is missing valid ODTUCLASS markers. Skipping update.`
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

				// Ensure parentId is in frontmatter
				const parentLink = `[[${courseTask.basename}|${courseTask.title}]]`;
				if (!updatedContent.match(/^parentId:\s*.*$/m)) {
					updatedContent = updatedContent.replace(/^type:\s*.*$/m, `type: "subtask"\nparentId: "${parentLink}"`);
				}

				await this.app.vault.modify(existingFile, updatedContent);

				if (assignment.suggestedProblems && Array.isArray(assignment.suggestedProblems) && assignment.suggestedProblems.length > 0) {
					await this.processSubtasks(assignment, existingFile, cleanTitle);
				}
			} else {
				if (!skipIfExists) {
					let updatedContent = renderedContent;
					const existingContent = await this.app.vault.read(existingFile);
					const notesHeader = '## Description';
					if (existingContent.includes(notesHeader)) {
						const descIdx = existingContent.indexOf(notesHeader);
						const userDesc = existingContent.slice(descIdx);
						const newDescIdx = updatedContent.indexOf(notesHeader);
						if (newDescIdx !== -1) {
							updatedContent = updatedContent.slice(0, newDescIdx) + userDesc;
						}
					}
					await this.app.vault.modify(existingFile, updatedContent);
				}
			}
		} else {
			targetFile = (await this.app.vault.create(outputPath, renderedContent)) as TFile;
			if (isSection && assignment.suggestedProblems && Array.isArray(assignment.suggestedProblems) && assignment.suggestedProblems.length > 0) {
				await this.processSubtasks(assignment, targetFile, cleanTitle);
			}
		}

		// Link this child task to its Course Task parent
		await this.linkChildToParent(courseTask.file, {
			basename: targetFile.basename,
			title: cleanTitle
		});
	}

	async processSubtasks(assignment: any, parentFile: TFile, parentCleanTitle: string) {
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
		const parentTitle = parentCleanTitle || parentBaseName;
		const weekPrefixMatch = parentTitle.match(/^(Week\s+\d+)/i) || parentBaseName.match(/^(Week\s+\d+)/i);
		const weekPrefix = weekPrefixMatch ? `${weekPrefixMatch[1]} - ` : '';
		const subtaskRefs: Array<{ basename: string; title: string }> = [];

		for (const item of assignment.suggestedProblems) {
			const sectionNum = item.section;
			const topicTitle = item.title ? ` ${item.title}` : '';
			const subtaskTitle = `${sectionNum}${topicTitle} — Suggested Problems`;
			const subtaskId = `${assignment.id}:subtask:${sectionNum}`;
			const safeSubtaskTitle = subtaskTitle.replace(/[\\/:*?"<>|]/g, '-').trim();
			const fullSubtaskBasename = `${weekPrefix}${safeSubtaskTitle}`;
			const subtaskFileName = `${fullSubtaskBasename}.md`;
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

			// 1. Find existing subtask by ID first, then fallback to subtaskPath
			let existingSubtask: TFile | null = null;
			const directSubtask = this.app.vault.getAbstractFileByPath(subtaskPath);
			if (directSubtask && directSubtask instanceof TFile) {
				existingSubtask = directSubtask;
			} else {
				const mdFiles = this.app.vault.getMarkdownFiles();
				for (const f of mdFiles) {
					const cache = this.app.metadataCache.getFileCache(f);
					if (cache?.frontmatter?.id === subtaskId) {
						existingSubtask = f;
						break;
					}
				}
			}

			if (!existingSubtask) {
				await this.app.vault.create(subtaskPath, renderedSubtask);
			} else {
				const subContent = await this.app.vault.read(existingSubtask);
				const expectedParentLink = `[[${parentBaseName}|${parentTitle}]]`;
				const mergedContent = this.mergeSuggestedProblemsContent(
					subContent,
					item.problems || [],
					sectionNum,
					expectedParentLink,
					assignment.weekEnd || ''
				);
				if (mergedContent !== subContent) {
					await this.app.vault.modify(existingSubtask, mergedContent);
				}
			}

			subtaskRefs.push({
				basename: fullSubtaskBasename,
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

	mergeSuggestedProblemsContent(
		existingContent: string,
		newProblems: string[],
		chapter: string,
		parentLink: string,
		dueDate: string
	): string {
		let content = existingContent;

		// 1. Update frontmatter parentId
		const expectedParent = `parentId: "${parentLink}"`;
		if (!content.includes(expectedParent)) {
			if (/^parentId:\s*.*$/m.test(content)) {
				content = content.replace(/^parentId:\s*.*$/m, expectedParent);
			} else {
				content = content.replace(/^type:\s*.*$/m, `type: "subtask"\n${expectedParent}`);
			}
		}

		// 2. Update frontmatter due
		if (dueDate) {
			const expectedDue = `due: "${dueDate}"`;
			if (!content.includes(expectedDue)) {
				if (/^due:\s*.*$/m.test(content)) {
					content = content.replace(/^due:\s*.*$/m, expectedDue);
				}
			}
		}

		// 3. Update Parent: [[...]] in body if present
		content = content.replace(/^Parent:\s*\[\[.*?\]\]$/m, `Parent: ${parentLink}`);

		// 4. Locate ## Suggested Problems and ## My Notes & Workspace
		const problemsHeaderRegex = /##\s+Suggested\s+Problems[^\n]*/i;
		const headerMatch = content.match(problemsHeaderRegex);
		if (!headerMatch || headerMatch.index === undefined) {
			return content;
		}

		const headerStart = headerMatch.index;
		const headerEnd = headerStart + headerMatch[0].length;

		const notesHeader = '## My Notes & Workspace';
		let notesStart = content.indexOf(notesHeader, headerEnd);
		if (notesStart === -1) {
			const nextHeading = content.slice(headerEnd).search(/\n##\s+/);
			notesStart = nextHeading !== -1 ? headerEnd + nextHeading : content.length;
		}

		const existingBlock = content.slice(headerEnd, notesStart);

		// Extract existing problem states
		const existingMap = new Map<string, { checked: boolean; extra: string }>();
		const lines = existingBlock.split('\n');
		for (const line of lines) {
			const m = line.match(/^-\s*\[([ xX])\]\s*(?:Problem\s+)?(\S+)(.*)$/);
			if (m) {
				const isChecked = m[1].toLowerCase() === 'x';
				const probNum = m[2].trim();
				const extra = m[3] || '';
				existingMap.set(probNum, { checked: isChecked, extra });
			}
		}

		// Build new problems list
		const newItems: string[] = [];
		const processedKeys = new Set<string>();

		for (const p of newProblems) {
			const pStr = String(p).trim();
			processedKeys.add(pStr);
			if (existingMap.has(pStr)) {
				const prev = existingMap.get(pStr)!;
				const mark = prev.checked ? '- [x]' : '- [ ]';
				newItems.push(`${mark} Problem ${pStr}${prev.extra}`);
			} else {
				newItems.push(`- [ ] Problem ${pStr}`);
			}
		}

		// Preserve any existing completed problems that are not in new list
		for (const [probNum, info] of existingMap.entries()) {
			if (!processedKeys.has(probNum) && info.checked) {
				newItems.push(`- [x] Problem ${probNum}${info.extra} <!-- removed from syllabus -->`);
			}
		}

		const newProblemsBlock = '\n\n' + newItems.join('\n') + '\n\n';
		content = content.slice(0, headerEnd) + newProblemsBlock + content.slice(notesStart);
		return content;
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

	renderTemplate(template: string, assignment: any, extra?: { parentFileName?: string; parentTitle?: string; cleanTitle?: string }): string {
		const open = this.formatOdtuclassDate(assignment.openAt);
		const due = this.formatOdtuclassDate(assignment.dueAt);
		const close = this.formatOdtuclassDate(assignment.closeAt);

		const data: Record<string, any> = {
			...assignment,
			parentFileName: extra?.parentFileName || '',
			parentTitle: extra?.parentTitle || '',
			cleanTitle: extra?.cleanTitle || assignment.title || '',
			title: extra?.cleanTitle || assignment.title || '',
			fullTitle: assignment.title || '',
			openDate: open.date,
			openTime: open.time,
			dueDate: assignment.type === 'section' ? (assignment.weekEnd || '') : due.date,
			dueTime: due.time,
			closeDate: close.date,
			closeTime: close.time,
			weekStart: assignment.weekStart || '',
			weekEnd: assignment.weekEnd || ''
		};

		const placeholders = [
			'id', 'title', 'cleanTitle', 'fullTitle', 'parentFileName', 'parentTitle',
			'courseName', 'courseId', 'moduleId', 'moduleType', 'url',
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
