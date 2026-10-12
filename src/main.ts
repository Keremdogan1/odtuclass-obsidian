import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from 'obsidian';
import {
	CourseSlideConfig,
	SyncHistoryEntry,
	SyncHistoryItem,
	fetchSlideManifestFromGithub,
	loadProcessedState,
	syncFromGithub
} from './githubSync';

interface ODTUClassSettings {
	outputFolder: string;
	templateFolder: string;
	githubOwner: string;
	githubRepo: string;
	githubToken: string;
	autoFormatSlideNames: boolean;
	courseSlideConfigs: Record<string, CourseSlideConfig>;
	syncHistory: SyncHistoryEntry[];
}

const DEFAULT_SETTINGS: ODTUClassSettings = {
	outputFolder: 'Projects/OdtüClass Tasks/_tasks',
	templateFolder: 'ODTUClass/Templates',
	githubOwner: 'Keremdogan1',
	githubRepo: 'odtuclass-sync',
	githubToken: '',
	autoFormatSlideNames: true,
	courseSlideConfigs: {
		CENG111: {
			courseCode: 'CENG111',
			courseName: '[CENG 111 ALL Sections] Introduction to Computer Eng. Concepts',
			enabled: true,
			targetFolder: 'Courses/CENG111/Slides',
			prompted: true
		}
	},
	syncHistory: []
}

interface NormalizedDates {
	date: string;
	time: string;
}

export default class ODTUClassPlugin extends Plugin {
	settings: ODTUClassSettings;
	settingTab?: ODTUClassSettingTab;

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

		this.settingTab = new ODTUClassSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.registerEvent(
			this.app.metadataCache.on('changed', async (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					await this.syncTaskBodyStatusWithFrontmatter(file);
				}
			})
		);
	}

	async syncTaskBodyStatusWithFrontmatter(file: TFile) {
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;
		if (!fm || !fm['pm-task'] || !fm.status) return;

		const statusStr = String(fm.status).toLowerCase().trim();
		let expectedDurum = 'Yapılacak';
		if (statusStr === 'done' || statusStr === 'completed' || statusStr === 'complete') {
			expectedDurum = 'Tamamlandı';
		} else if (statusStr === 'in-progress' || statusStr === 'doing') {
			expectedDurum = 'Devam Ediyor';
		}

		const content = await this.app.vault.read(file);
		const durumRegex = /^(-\s*\*\*Durum:\*\*\s*)(.*)$/m;
		const match = content.match(durumRegex);
		if (match && match[2].trim() !== expectedDurum) {
			const updated = content.replace(durumRegex, `$1${expectedDurum}`);
			await this.app.vault.modify(file, updated);
		}
	}

	onunload() { }

	async loadSettings() {
		const loaded = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
		this.settings.courseSlideConfigs = Object.assign(
			{},
			DEFAULT_SETTINGS.courseSlideConfigs,
			loaded?.courseSlideConfigs || {}
		);
		if (!Array.isArray(this.settings.syncHistory)) {
			this.settings.syncHistory = [];
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async recordSyncHistory(entry: SyncHistoryEntry) {
		if (!Array.isArray(this.settings.syncHistory)) {
			this.settings.syncHistory = [];
		}
		this.settings.syncHistory.unshift(entry);
		if (this.settings.syncHistory.length > 40) {
			this.settings.syncHistory = this.settings.syncHistory.slice(0, 40);
		}
		await this.saveSettings();
		if (this.settingTab && this.settingTab.containerEl && this.settingTab.containerEl.isShown()) {
			this.settingTab.display();
		}
	}

	async seedSyncHistoryFromVault(forceRebuild: boolean = false): Promise<number> {
		if (!forceRebuild && this.settings.syncHistory && this.settings.syncHistory.length > 0) {
			return 0;
		}
		try {
			const state = await loadProcessedState(this.app.vault.adapter);
			const entries = Object.entries(state);
			if (entries.length === 0) return 0;

			// Map vault markdown files by frontmatter id and basename
			const fileById = new Map<string, { file: TFile; fm: any }>();
			const subtasksByParentPrefix = new Map<string, Array<{ file: TFile; fm: any }>>();
			const courseTitleByCourseId = new Map<string, string>();

			for (const file of this.app.vault.getMarkdownFiles()) {
				if (!file.path.startsWith(this.settings.outputFolder)) continue;
				const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
				if (!fm) continue;
				if (fm['odtuclass-course-id'] && fm.type === 'task') {
					courseTitleByCourseId.set(String(fm['odtuclass-course-id']), String(fm.title || file.basename));
				}
				if (fm.id) {
					const idStr = String(fm.id);
					fileById.set(idStr, { file, fm });
					const subMatch = idStr.match(/^(section:\d+:\d+):subtask:/);
					if (subMatch) {
						const secId = subMatch[1];
						if (!subtasksByParentPrefix.has(secId)) {
							subtasksByParentPrefix.set(secId, []);
						}
						subtasksByParentPrefix.get(secId)!.push({ file, fm });
					}
				}
			}

			// Sort processed entries by timestamp ascending so we can cluster into sync runs (within 3 minutes)
			const sorted = entries
				.map(([id, meta]) => ({
					id,
					ts: meta?.processedAt ? new Date(meta.processedAt).getTime() : 0,
					iso: meta?.processedAt || new Date().toISOString()
				}))
				.filter((e) => e.ts > 0 && fileById.has(e.id))
				.sort((a, b) => a.ts - b.ts);

			const clusters: Array<{ ts: number; iso: string; ids: string[] }> = [];
			const CLUSTER_WINDOW_MS = 3 * 60 * 1000;
			for (const item of sorted) {
				const last = clusters[clusters.length - 1];
				if (!last || item.ts - last.ts > CLUSTER_WINDOW_MS) {
					clusters.push({ ts: item.ts, iso: item.iso, ids: [item.id] });
				} else {
					last.ids.push(item.id);
					last.ts = item.ts;
					last.iso = item.iso;
				}
			}

			const reconstructed: SyncHistoryEntry[] = [];
			for (const cluster of clusters.reverse()) {
				const historyItems: SyncHistoryItem[] = [];
				let createdCount = 0;

				for (const id of cluster.ids) {
					const match = fileById.get(id);
					if (!match) continue;
					const { file, fm } = match;
					const isSection = id.startsWith('section:');
					const courseIdPart = id.split(':')[1] || String(fm['odtuclass-course-id'] || '');
					const courseCode =
						courseTitleByCourseId.get(courseIdPart) ||
						this.extractCanonicalCourseCode(String(fm.course || fm.parentId || '')) ||
						'ODTUClass';
					const parentRaw = String(fm.parentId || '');
					const parentPipe = parentRaw.match(/\[\[.*?\|(.*?)\]\]/) || parentRaw.match(/\[\[(.*?)\]\]/);
					const parentTitle = parentPipe ? parentPipe[1] : '';

					createdCount++;
					historyItems.push({
						action: 'created',
						title: String(fm.title || file.basename),
						courseCode,
						parentTitle,
						filePath: file.path,
						detail: isSection ? 'Haftalık bölüm eklendi' : 'Ödev/görev eklendi'
					});

					if (isSection && subtasksByParentPrefix.has(id)) {
						for (const sub of subtasksByParentPrefix.get(id)!) {
							createdCount++;
							historyItems.push({
								action: 'created',
								title: String(sub.fm.title || sub.file.basename),
								courseCode,
								parentTitle: String(fm.title || file.basename),
								filePath: sub.file.path,
								detail: 'Suggested Problems alt görevi eklendi'
							});
						}
					}
				}

				if (historyItems.length > 0) {
					reconstructed.push({
						id: `snapshot-${cluster.ts}`,
						timestamp: cluster.iso,
						source: 'snapshot',
						stats: {
							created: createdCount,
							updated: 0,
							moved: 0,
							slidesDownloaded: 0,
							slidesReplaced: 0,
							filtered: 0,
							skipped: 0,
							failed: 0
						},
						items: historyItems
					});
				}
			}

			if (forceRebuild) {
				const nonSnapshots = (this.settings.syncHistory || []).filter((h) => h.source !== 'snapshot');
				this.settings.syncHistory = [...nonSnapshots, ...reconstructed].slice(0, 40);
			} else {
				this.settings.syncHistory = reconstructed.slice(0, 40);
			}
			await this.saveSettings();
			return reconstructed.length;
		} catch (e) {
			console.warn('[ODTUClass] Could not seed sync history from vault:', e);
			return 0;
		}
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
		let createdCount = 0;
		let updatedCount = 0;
		let movedCount = 0;
		let filteredCount = 0;
		let failCount = 0;
		const historyItems: SyncHistoryItem[] = [];

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
				
				const res = await this.processAssignment(assignment);
				if (res) {
					if (res.action === 'filtered') {
						filteredCount++;
						historyItems.push({
							action: 'filtered',
							title: res.title,
							courseCode: res.courseCode,
							detail: res.detail
						});
					} else {
						if (res.action === 'created') {
							createdCount++;
							historyItems.push({
								action: 'created',
								title: res.title,
								courseCode: res.courseCode,
								parentTitle: res.parentTitle,
								filePath: res.filePath,
								detail: res.isSection ? 'Haftalık bölüm eklendi' : 'Yeni ödev/görev eklendi'
							});
						} else if (res.action === 'updated') {
							updatedCount++;
							historyItems.push({
								action: 'updated',
								title: res.title,
								courseCode: res.courseCode,
								parentTitle: res.parentTitle,
								filePath: res.filePath,
								detail: res.isSection ? 'Haftalık bölüm güncellendi' : 'Ödev/görev güncellendi'
							});
						}
						if (Array.isArray(res.subtasksAdded)) {
							for (const st of res.subtasksAdded) {
								createdCount++;
								historyItems.push({
									action: 'created',
									title: st.title,
									courseCode: res.courseCode,
									parentTitle: res.title,
									filePath: st.filePath,
									detail: 'Suggested Problems alt görevi eklendi'
								});
							}
						}
						if (Array.isArray(res.subtasksMoved)) {
							for (const mv of res.subtasksMoved) {
								movedCount++;
								historyItems.push({
									action: 'moved',
									title: mv.title,
									courseCode: res.courseCode,
									parentTitle: res.title,
									filePath: mv.filePath,
									detail: mv.detail
								});
							}
						}
					}
				}
				
				await this.app.vault.adapter.remove(filePath);
				processedCount++;
			} catch (error) {
				failCount++;
				console.error(`Failed to process assignment file ${filePath}:`, error);
				new Notice(`Failed to process assignment: ${filePath}. Check console for details.`);
			}
		}

		if (processedCount > 0 || failCount > 0) {
			await this.recordSyncHistory({
				id: `local-${Date.now()}`,
				timestamp: new Date().toISOString(),
				source: 'local',
				stats: {
					created: createdCount,
					updated: updatedCount,
					moved: movedCount,
					slidesDownloaded: 0,
					slidesReplaced: 0,
					filtered: filteredCount,
					skipped: 0,
					failed: failCount
				},
				items: historyItems
			});
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

		// 4. Strip trailing activity type suffixes like "  Interactive Content", "  Quiz"
		clean = clean.replace(/\s+(Interactive Content|Interactive Video|Quiz)$/i, '').trim();
		clean = clean.replace(/\s+/g, ' ').trim();

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
		} else {
			// Clean recitation titles like "Math119_recitation_2026-1_week02" -> "Week 2: Recitation"
			const recMatch = clean.match(/^(?:Math\s*\d+|[A-Z]{3,4}\s*\d{3})?[_\s-]*recitation[_\s-]*(?:\d{4}-\d[_\s-]*)?week\s*0?(\d+)/i)
				|| clean.match(/^(?:Math\s*\d+|[A-Z]{3,4}\s*\d{3})?[_\s-]*week\s*0?(\d+)[_\s-]*recitation/i);
			if (recMatch) {
				return `Week ${recMatch[1]}: Recitation`;
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

	extractCanonicalCourseCode(text?: string): string {
		if (!text) return '';
		const isLab = /\blabs?\b/i.test(text);
		const m = text.match(/\b([A-Z]{2,4})\s*(\d{3})\b/i);
		if (!m) return '';
		const code = `${m[1].toUpperCase()} ${m[2]}`;
		return isLab ? `${code} LAB` : code;
	}

	async getOrCreateCourseTask(courseId: string | number, courseName: string): Promise<{ file: TFile; basename: string; title: string }> {
		const courseIdStr = String(courseId);
		const targetCourseCode = this.extractCanonicalCourseCode(courseName);

		// 1. Search in outputFolder ONLY for actual course-level tasks (never assignment/section subtasks!)
		const folder = this.app.vault.getAbstractFileByPath(this.settings.outputFolder);
		if (folder && folder instanceof TFolder) {
			for (const child of folder.children) {
				if (child instanceof TFile && child.extension === 'md') {
					const cache = this.app.metadataCache.getFileCache(child);
					const fm = cache?.frontmatter;
					if (fm) {
						const fmId = typeof fm.id === 'string' ? fm.id : '';
						const isCourseNote =
							fmId.startsWith('course:') ||
							(fm['pm-task'] === true &&
								fm.type === 'task' &&
								!fm.parentId &&
								!fmId.startsWith('section:') &&
								!fmId.startsWith('assignment:') &&
								!fmId.startsWith('calendar:') &&
								fm['odtuclass-module-id'] === undefined &&
								fm['odtuclass-section-id'] === undefined);

						if (!isCourseNote) continue;

						const candCode = this.extractCanonicalCourseCode(
							String(fm.title || fm['odtuclass-course'] || child.basename),
						);

						if (
							fmId === `course:${courseIdStr}` ||
							String(fm['odtuclass-course-id']) === courseIdStr ||
							fm.title === courseName ||
							(targetCourseCode && candCode === targetCourseCode)
						) {
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
			const codePart = bracketMatch[1]
				.replace(/\s+(?:All\s+Sections?|Sections?\s*\d+)/i, '')
				.trim();
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
			const taskIdsRegex = /^taskIds:\s*(\[.*\])$/m;
			const taskIdsMatch = content.match(taskIdsRegex);
			if (taskIdsMatch) {
				try {
					const existingArray = JSON.parse(taskIdsMatch[1]);
					if (Array.isArray(existingArray)) {
						existingArray.push(courseLink);
						content = content.replace(taskIdsRegex, `taskIds: ${JSON.stringify(existingArray)}`);
					}
				} catch (e) {
					console.warn('[ODTUClass] Could not JSON.parse taskIds in project file, skipping inline splice:', e);
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

		let changed = false;

		// 1. Update subtaskIds in frontmatter safely (supports [], ["..."], or multi-line - "...")
		const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
		const fmMatch = content.match(fmRegex);
		if (fmMatch) {
			let fmText = fmMatch[1];
			const subtaskBlockRegex = /^subtaskIds:[ \t]*(?:(\[[^\r\n]*\])|[ \t]*(?:\r?\n((?:[ \t]*-[ \t]+[^\r\n]+\r?\n?)*))?)/m;
			const blockMatch = fmText.match(subtaskBlockRegex);
			const existingItems: string[] = [];

			if (blockMatch) {
				if (blockMatch[1]) {
					const inlineVal = blockMatch[1].trim();
					if (inlineVal !== '[]') {
						try {
							const parsed = JSON.parse(inlineVal);
							if (Array.isArray(parsed)) {
								for (const item of parsed) {
									if (typeof item === 'string' && item.trim()) {
										existingItems.push(item.trim());
									}
								}
							}
						} catch {
							// Fallback regex extraction
							const linkMatches = inlineVal.match(/\[\[.*?\]\]/g) || [];
							existingItems.push(...linkMatches);
						}
					}
				} else if (blockMatch[2]) {
					const lines = blockMatch[2].split(/\r?\n/);
					for (const line of lines) {
						const m = line.match(/^[ \t]*-[ \t]+(.*?)\s*$/);
						if (m && m[1]) {
							existingItems.push(m[1].replace(/^["']|["']$/g, '').trim());
						}
					}
				}
			}

			const alreadyHas = existingItems.some(
				(item) =>
					item.includes(`[[${childRef.basename}|`) ||
					item.includes(`[[${childRef.basename}]]`),
			);

			if (!alreadyHas) {
				existingItems.push(childLink);
				const yamlList =
					existingItems.length > 0
						? `subtaskIds:\n${existingItems.map((it) => `  - "${it}"`).join('\n')}`
						: `subtaskIds: []`;

				if (blockMatch) {
					fmText = fmText.replace(subtaskBlockRegex, yamlList);
				} else {
					fmText = `${fmText.trimEnd()}\n${yamlList}`;
				}
				content = content.replace(fmRegex, `---\n${fmText}\n---`);
				changed = true;
			}
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
					const newSubtaskLine = `\n- [ ] ${childLink}`;
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

	async unlinkChildFromParent(parentFile: TFile, childBasename: string) {
		let content = await this.app.vault.read(parentFile);
		let changed = false;

		const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
		const fmMatch = content.match(fmRegex);
		if (fmMatch) {
			let fmText = fmMatch[1];
			const subtaskBlockRegex = /^subtaskIds:[ \t]*(?:(\[[^\r\n]*\])|[ \t]*\r?\n((?:[ \t]*-[ \t]+[^\r\n]+\r?\n?)*))?/m;
			const blockMatch = fmText.match(subtaskBlockRegex);
			if (blockMatch) {
				const existingItems: string[] = [];
				if (blockMatch[1]) {
					const inlineVal = blockMatch[1].trim();
					if (inlineVal !== '[]') {
						try {
							const parsed = JSON.parse(inlineVal);
							if (Array.isArray(parsed)) {
								for (const item of parsed) {
									if (typeof item === 'string' && item.trim()) {
										existingItems.push(item.trim());
									}
								}
							}
						} catch {
							const linkMatches = inlineVal.match(/\[\[.*?\]\]/g) || [];
							existingItems.push(...linkMatches);
						}
					}
				} else if (blockMatch[2]) {
					const lines = blockMatch[2].split(/\r?\n/);
					for (const line of lines) {
						const m = line.match(/^[ \t]*-[ \t]+(.*?)\s*$/);
						if (m && m[1]) {
							existingItems.push(m[1].replace(/^["']|["']$/g, '').trim());
						}
					}
				}

				const filteredItems = existingItems.filter(
					(item) =>
						!item.includes(`[[${childBasename}|`) &&
						!item.includes(`[[${childBasename}]]`),
				);

				if (filteredItems.length !== existingItems.length) {
					const yamlList =
						filteredItems.length > 0
							? `subtaskIds:\n${filteredItems.map((it) => `  - "${it}"`).join('\n')}`
							: `subtaskIds: []`;
					fmText = fmText.replace(subtaskBlockRegex, yamlList);
					content = content.replace(fmRegex, `---\n${fmText}\n---`);
					changed = true;
				}
			}
		}

		// Remove from body checklist
		const escapedBase = childBasename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const lineRegex = new RegExp(`^[ \\t]*-[ \\t]*\\[[xX ]\\][ \\t]*\\[\\[${escapedBase}(?:\\|[^\\]]*)?\\]\\][^\\r\\n]*\\r?\\n?`, 'gm');
		const newContent = content.replace(lineRegex, '');
		if (newContent !== content) {
			content = newContent;
			changed = true;
		}

		if (changed) {
			await this.app.vault.modify(parentFile, content);
		}
	}

	async findParentSectionTask(courseId: string | number, cleanTitle: string, assignment: any): Promise<{ file: TFile; basename: string; title: string } | null> {
		const courseIdStr = String(courseId);
		const folder = this.app.vault.getAbstractFileByPath(this.settings.outputFolder);
		if (!folder || !(folder instanceof TFolder)) return null;

		// 1. Try to extract week number from cleanTitle or rawTitle
		let weekNum: number | null = null;
		const rawTitle = assignment.title || '';
		const fullText = `${cleanTitle} ${rawTitle}`;
		const weekMatch = fullText.match(/\bweek\s*0?(\d+)\b/i);
		if (weekMatch) {
			weekNum = parseInt(weekMatch[1], 10);
		} else if (assignment.weekNumber) {
			weekNum = parseInt(assignment.weekNumber, 10);
		} else if (assignment.sectionNumber !== undefined && assignment.sectionNumber !== null) {
			const parsedSec = parseInt(assignment.sectionNumber, 10);
			if (!isNaN(parsedSec)) weekNum = parsedSec;
		} else if (/preliminaries|ch\.?\s*0\b/i.test(fullText)) {
			weekNum = 1;
		} else if (/limit\s+and\s+continuity.*basics/i.test(fullText)) {
			weekNum = 2;
		} else if (/formal\s+definitions.*differentiation/i.test(fullText)) {
			weekNum = 3;
		} else {
			const chMatch = fullText.match(/\bch(?:apter|\.)?\s*0?([1-9]\d*)\b/i);
			if (chMatch) {
				weekNum = parseInt(chMatch[1], 10);
			}
		}

		// 2. Check due date and open/start/creation date if available
		const dueDateStr = assignment.due || assignment.dueDate || assignment.dueAt || '';
		let dueIso = '';
		if (dueDateStr) {
			const d = new Date(dueDateStr);
			if (!isNaN(d.getTime())) {
				dueIso = this.formatOdtuclassDate(dueDateStr).date;
			}
		}

		const openDateStr = assignment.start || assignment.openDate || assignment.openAt || assignment.createdAt || '';
		let openIso = '';
		if (openDateStr) {
			const d = new Date(openDateStr);
			if (!isNaN(d.getTime())) {
				openIso = this.formatOdtuclassDate(openDateStr).date;
			}
		}

		const targetSectionId = assignment.sectionId !== undefined && assignment.sectionId !== null ? String(assignment.sectionId) : '';
		const targetSectionName = (assignment.sectionName || '').trim().toLowerCase();
		const targetCourseCode = this.extractCanonicalCourseCode(assignment.courseName || '');

		const candidateSections: { file: TFile; fm: any; basename: string; title: string }[] = [];

		for (const child of folder.children) {
			if (child instanceof TFile && child.extension === 'md') {
				const cache = this.app.metadataCache.getFileCache(child);
				const fm = cache?.frontmatter;
				if (!fm) continue;

				const fmId = typeof fm.id === 'string' ? fm.id : '';
				// Never treat course notes, assignments, calendar tasks, or suggested problem subtasks as weekly sections!
				if (
					fmId.startsWith('course:') ||
					fmId.startsWith('assignment:') ||
					fmId.startsWith('calendar:') ||
					fmId.includes(':subtask:') ||
					fm['odtuclass-module-id'] !== undefined
				) {
					continue;
				}

				const candCourseCode = this.extractCanonicalCourseCode(
					String(fm['odtuclass-course'] || fm.parentId || ''),
				);
				const isSameCourse =
					String(fm['odtuclass-course-id']) === courseIdStr ||
					fmId.startsWith(`section:${courseIdStr}:`) ||
					(targetCourseCode !== '' && candCourseCode === targetCourseCode);
				if (!isSameCourse) continue;

				const isSectionNote =
					fmId.startsWith('section:') ||
					fm['odtuclass-section-id'] !== undefined;

				if (isSectionNote) {
					candidateSections.push({
						file: child,
						fm,
						basename: child.basename,
						title: fm.title || child.basename
					});
				}
			}
		}

		// Priority 1: Match by exact sectionId
		if (targetSectionId) {
			for (const cand of candidateSections) {
				const fmSectionId = cand.fm['odtuclass-section-id'] ? String(cand.fm['odtuclass-section-id']) : '';
				const fmId = typeof cand.fm.id === 'string' ? cand.fm.id : '';
				if (fmSectionId === targetSectionId || fmId === `section:${courseIdStr}:${targetSectionId}` || fmId.endsWith(`:${targetSectionId}`)) {
					return { file: cand.file, basename: cand.basename, title: cand.title };
				}
			}
		}

		// Priority 2: Match by sectionName
		if (targetSectionName) {
			for (const cand of candidateSections) {
				const candTitle = (cand.title || '').toLowerCase();
				const candBase = cand.basename.toLowerCase();
				if (candTitle === targetSectionName || candBase === targetSectionName ||
					candTitle.includes(targetSectionName) || targetSectionName.includes(candTitle)) {
					return { file: cand.file, basename: cand.basename, title: cand.title };
				}
			}
		}

		// Priority 3: Match by week number
		if (weekNum !== null) {
			for (const cand of candidateSections) {
				const fmTitle = (cand.title || cand.basename).toLowerCase();
				const fmWeekMatch = fmTitle.match(/\bweek\s*0?(\d+)\b/i) || cand.basename.toLowerCase().match(/\bweek-0?(\d+)\b/i);
				const sectionWeekNum = fmWeekMatch ? parseInt(fmWeekMatch[1], 10) : (cand.fm.sectionNumber ? parseInt(cand.fm.sectionNumber, 10) : null);
				if (sectionWeekNum === weekNum) {
					return { file: cand.file, basename: cand.basename, title: cand.title };
				}
			}
		}

		// Priority 4: Match by open/start/creation date within section weekStart / weekEnd
		let earliestSection: { file: TFile; basename: string; title: string; startStr: string } | null = null;
		if (openIso) {
			for (const cand of candidateSections) {
				if (cand.fm.weekStart && cand.fm.weekEnd) {
					const startStr = String(cand.fm.weekStart).slice(0, 10);
					const endStr = String(cand.fm.weekEnd).slice(0, 10);
					if (openIso >= startStr && openIso <= endStr) {
						return { file: cand.file, basename: cand.basename, title: cand.title };
					}
					if (!earliestSection || startStr < earliestSection.startStr) {
						earliestSection = { file: cand.file, basename: cand.basename, title: cand.title, startStr };
					}
				}
			}
		}

		// Priority 5: Match by due date within section weekStart / weekEnd
		if (dueIso) {
			for (const cand of candidateSections) {
				if (cand.fm.weekStart && cand.fm.weekEnd) {
					const startStr = String(cand.fm.weekStart).slice(0, 10);
					const endStr = String(cand.fm.weekEnd).slice(0, 10);
					if (dueIso >= startStr && dueIso <= endStr) {
						return { file: cand.file, basename: cand.basename, title: cand.title };
					}
				}
			}
		}

		// Priority 6: If openIso was before the semester started (and dueIso is semester-wide), assign to Week 1
		if (openIso && earliestSection && openIso < earliestSection.startStr) {
			return { file: earliestSection.file, basename: earliestSection.basename, title: earliestSection.title };
		}

		return null;
	}

	async findWeeklySectionTask(courseId: string | number, cleanTitle: string, assignment: any): Promise<{ file: TFile; basename: string; title: string } | null> {
		return this.findParentSectionTask(courseId, cleanTitle, assignment);
	}

	isNonTaskPayload(assignment: any): boolean {
		if (!assignment || assignment.type === 'section') return false;
		if (assignment.isTask === false || assignment.notificationCategory === 'announcement') return true;
		const modType = String(assignment.moduleType || '').toLowerCase();
		const title = String(assignment.title || '');
		if (modType === 'attendance' || /\b(?:attend[ae]nce|yoklama|roll[\s-]*call)\b/i.test(title)) {
			return true;
		}
		if (
			/\b(?:solved[\s_-]*problems?|answer[\s_-]*key|syllabus|course[\s_-]*outline|section[\s_-]*transfer|course[\s_-]*conflict|helproom|help\s+room)\b/i.test(
				title,
			)
		) {
			return true;
		}
		return false;
	}

	async processAssignment(
		assignment: any,
		skipIfExists: boolean = false
	): Promise<{
		action: 'created' | 'updated' | 'unchanged' | 'filtered';
		title: string;
		courseCode: string;
		parentTitle?: string;
		filePath?: string;
		isSection?: boolean;
		detail?: string;
		subtasksAdded?: Array<{ title: string; filePath: string }>;
		subtasksMoved?: Array<{ title: string; filePath: string; detail: string }>;
	} | null> {
		if (this.isNonTaskPayload(assignment)) {
			return {
				action: 'filtered',
				title: String(assignment?.title || 'Untitled'),
				courseCode: this.extractCanonicalCourseCode(assignment?.courseName) || 'ODTUClass',
				detail: 'Görev dışı içerik filtrelendi (duyuru / yoklama / çözümlü sorular)'
			};
		}
		const courseTask = await this.getOrCreateCourseTask(assignment.courseId, assignment.courseName);

		const isSection = assignment.type === 'section';
		const cleanTitle = this.cleanItemTitle(assignment.title, assignment.courseName, isSection, assignment);

		let parentTask = courseTask;
		if (!isSection) {
			const sectionParent = await this.findParentSectionTask(assignment.courseId, cleanTitle, assignment);
			if (sectionParent) {
				parentTask = sectionParent;
			}
		}

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
			parentFileName: parentTask.basename,
			parentTitle: parentTask.title,
			cleanTitle: cleanTitle
		});
		
		const safeTitle = cleanTitle.replace(/[\\/:*?"<>|\[\]]/g, '-').trim();
		const safeId = assignment.id.replace(/[^a-zA-Z0-9.-]/g, '-');
		
		const outputPath = `${this.settings.outputFolder}/${safeTitle} - ${safeId}.md`;
		
		// Find existing file either by exact outputPath or by ID / Pearson title in filename / frontmatter
		let existingFile: TFile | null = null;
		const directFile = this.app.vault.getAbstractFileByPath(outputPath);
		if (directFile && directFile instanceof TFile) {
			existingFile = directFile;
		} else {
			const folder = this.app.vault.getAbstractFileByPath(this.settings.outputFolder);
			if (folder && folder instanceof TFolder) {
				const normCleanTitle = cleanTitle.toLowerCase().replace(/[^a-z0-9]+/g, '');
				for (const child of folder.children) {
					if (child instanceof TFile && child.extension === 'md') {
						if (child.basename.endsWith(`- ${safeId}`)) {
							existingFile = child;
							break;
						}
						const cache = this.app.metadataCache.getFileCache(child);
						const fm = cache?.frontmatter;
						if (fm?.id === assignment.id) {
							existingFile = child;
							break;
						}
						if (
							assignment.moduleType === 'pearson' &&
							fm &&
							String(fm['odtuclass-course-id']) === String(assignment.courseId) &&
							typeof fm.title === 'string' &&
							fm.title.toLowerCase().replace(/[^a-z0-9]+/g, '') === normCleanTitle
						) {
							existingFile = child;
							break;
						}
					}
				}
			}
		}

		let targetFile: TFile;
		let action: 'created' | 'updated' | 'unchanged' = existingFile ? 'unchanged' : 'created';
		let subtaskResult: {
			added: Array<{ title: string; filePath: string }>;
			moved: Array<{ title: string; filePath: string; detail: string }>;
		} = { added: [], moved: [] };

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
					return null;
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
				if (/^parentId:\s*.*$/m.test(updatedContent)) {
					updatedContent = updatedContent.replace(/^parentId:\s*.*$/m, `parentId: "${parentLink}"`);
				} else {
					updatedContent = updatedContent.replace(/^type:\s*.*$/m, `type: "subtask"\nparentId: "${parentLink}"`);
				}

				if (updatedContent !== existingContent) {
					await this.app.vault.modify(existingFile, updatedContent);
					action = 'updated';
				}

				if (assignment.suggestedProblems && Array.isArray(assignment.suggestedProblems) && assignment.suggestedProblems.length > 0) {
					subtaskResult = await this.processSubtasks(assignment, existingFile, cleanTitle);
				}
			} else {
				if (!skipIfExists) {
					const existingContent = await this.app.vault.read(existingFile);
					let updatedContent = existingContent;

					const expectedParentLink = `[[${parentTask.basename}|${parentTask.title}]]`;
					if (/^parentId:\s*.*$/m.test(updatedContent)) {
						updatedContent = updatedContent.replace(/^parentId:\s*.*$/m, `parentId: "${expectedParentLink}"`);
					} else {
						updatedContent = updatedContent.replace(/^type:\s*.*$/m, `type: "subtask"\nparentId: "${expectedParentLink}"`);
					}
					updatedContent = updatedContent.replace(/^type:\s*.*$/m, `type: "subtask"`);

					const existingStatusMatch = existingContent.match(/^status:\s*["']?([^"'\r\n]+)["']?/m);
					const existingStatus = existingStatusMatch ? existingStatusMatch[1].trim() : 'todo';
					let finalStatus = existingStatus;
					if (existingStatus === 'done' || assignment.status === 'done') {
						finalStatus = 'done';
					} else if (assignment.status === 'in-progress' && existingStatus === 'todo') {
						finalStatus = 'in-progress';
					}

					updatedContent = updatedContent.replace(/^status:\s*.*$/m, `status: "${finalStatus}"`);

					const open = this.formatOdtuclassDate(assignment.openAt);
					const due = this.formatOdtuclassDate(assignment.dueAt);

					if (open.date) {
						if (/^start:\s*.*$/m.test(updatedContent)) {
							updatedContent = updatedContent.replace(/^start:\s*.*$/m, `start: "${open.date}"`);
						} else {
							updatedContent = updatedContent.replace(/^due:\s*.*$/m, `start: "${open.date}"\n$&`);
						}
						if (/^opened:\s*.*$/m.test(updatedContent)) {
							updatedContent = updatedContent.replace(/^opened:\s*.*$/m, `opened: "${open.date}"`);
						}
						const openDisplay = `${open.date}${open.time ? ` ${open.time}` : ''}`;
						if (/^-\s*\*\*(?:Açılış|Başlangıç):\*\*\s*.*$/m.test(updatedContent)) {
							updatedContent = updatedContent.replace(/^-\s*\*\*(Açılış|Başlangıç):\*\*\s*.*$/m, `- **$1:** ${openDisplay}`);
						} else if (/^-\s*\*\*Teslim:\*\*\s*.*$/m.test(updatedContent)) {
							updatedContent = updatedContent.replace(/^-\s*\*\*Teslim:\*\*\s*.*$/m, `- **Başlangıç:** ${openDisplay}\n$&`);
						}
					}

					if (due.date) {
						updatedContent = updatedContent.replace(/^due:\s*.*$/m, `due: "${due.date}"`);
						const dueDisplay = `${due.date}${due.time ? ` ${due.time}` : ''}`;
						updatedContent = updatedContent.replace(/^(-\s*\*\*Teslim:\*\*\s*).*$/m, `$1${dueDisplay}`);
					}

					const expectedDurum = finalStatus === 'done' ? 'Tamamlandı' : (finalStatus === 'in-progress' ? 'Devam Ediyor' : 'Yapılacak');
					if (/^-\s*\*\*Durum:\*\*\s*.*$/m.test(updatedContent)) {
						updatedContent = updatedContent.replace(/^(-\s*\*\*Durum:\*\*\s*).*$/m, `$1${expectedDurum}`);
					}

					const descText = String(assignment.description || assignment.content || '').trim();
					if (descText) {
						const descBegin = '<!-- ODTUCLASS:DESCRIPTION:BEGIN -->';
						const descEnd = '<!-- ODTUCLASS:DESCRIPTION:END -->';
						const bIdx = updatedContent.indexOf(descBegin);
						const eIdx = updatedContent.indexOf(descEnd);
						if (bIdx !== -1 && eIdx !== -1 && eIdx > bIdx) {
							updatedContent =
								updatedContent.slice(0, bIdx + descBegin.length) +
								`\n${descText}\n` +
								updatedContent.slice(eIdx);
						} else if (/^##\s+Description\s*$/m.test(updatedContent)) {
							updatedContent = updatedContent.replace(
								/^##\s+Description\s*$/m,
								`## Description\n\n${descBegin}\n${descText}\n${descEnd}`,
							);
						}
					}

					if (updatedContent !== existingContent) {
						await this.app.vault.modify(existingFile, updatedContent);
						action = 'updated';
					}
				}
			}
		} else {
			let initialContent = renderedContent;
			const open = this.formatOdtuclassDate(assignment.openAt);
			if (open.date && !/^start:\s*.*$/m.test(initialContent)) {
				initialContent = initialContent.replace(/^due:\s*.*$/m, `start: "${open.date}"\n$&`);
			}
			if (assignment.status === 'done') {
				initialContent = initialContent.replace(/^status:\s*.*$/m, `status: "done"`);
				initialContent = initialContent.replace(/^(-\s*\*\*Durum:\*\*\s*).*$/m, `$1Tamamlandı`);
			} else if (assignment.status === 'in-progress') {
				initialContent = initialContent.replace(/^status:\s*.*$/m, `status: "in-progress"`);
				initialContent = initialContent.replace(/^(-\s*\*\*Durum:\*\*\s*).*$/m, `$1Devam Ediyor`);
			}
			targetFile = (await this.app.vault.create(outputPath, initialContent)) as TFile;
			action = 'created';
			if (isSection && assignment.suggestedProblems && Array.isArray(assignment.suggestedProblems) && assignment.suggestedProblems.length > 0) {
				subtaskResult = await this.processSubtasks(assignment, targetFile, cleanTitle);
			}
		}

		// Link this child task to its parent (weekly section or course task)
		await this.linkChildToParent(parentTask.file, {
			basename: targetFile.basename,
			title: cleanTitle
		});

		return {
			action,
			title: cleanTitle,
			courseCode: courseTask.title,
			parentTitle: parentTask.title,
			filePath: targetFile.path,
			isSection,
			subtasksAdded: subtaskResult.added,
			subtasksMoved: subtaskResult.moved
		};
	}

	async processSubtasks(
		assignment: any,
		parentFile: TFile,
		parentCleanTitle: string
	): Promise<{
		added: Array<{ title: string; filePath: string }>;
		moved: Array<{ title: string; filePath: string; detail: string }>;
	}> {
		const added: Array<{ title: string; filePath: string }> = [];
		const moved: Array<{ title: string; filePath: string; detail: string }> = [];
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
subtaskIds: []
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

		const currentWeekMatch = weekPrefixMatch ? parseInt(weekPrefixMatch[1].replace(/\D+/g, ''), 10) : null;
		const coursePrefix = `section:${assignment.courseId}:`;

		for (const item of assignment.suggestedProblems) {
			const sectionNum = item.section;
			const topicTitle = item.title ? ` ${item.title}` : '';
			const baseSubtaskTitle = `${sectionNum}${topicTitle} — Suggested Problems`;
			const subtaskId = `${assignment.id}:subtask:${sectionNum}`;
			const safeSubtaskTitle = baseSubtaskTitle.replace(/[\\/:*?"<>|\[\]]/g, '-').trim();
			const fullSubtaskBasename = `${weekPrefix}${safeSubtaskTitle}`;
			const subtaskFileName = `${fullSubtaskBasename}.md`;
			const subtaskPath = `${this.settings.outputFolder}/${subtaskFileName}`;

			// Find if existingSubtask for the current week already exists
			let existingSubtask: TFile | null = null;
			const directSubtask = this.app.vault.getAbstractFileByPath(subtaskPath);
			if (directSubtask && directSubtask instanceof TFile) {
				existingSubtask = directSubtask;
			} else {
				for (const f of this.app.vault.getMarkdownFiles()) {
					const cache = this.app.metadataCache.getFileCache(f);
					if (cache?.frontmatter?.id === subtaskId) {
						existingSubtask = f;
						break;
					}
				}
			}

			const rawProblems: string[] = (item.problems || []).map((p: string) => String(p).trim());
			const rawProblemSet = new Set<string>(rawProblems);

			const earlierProblems = new Set<string>();
			const carriedOverChecked = new Set<string>();
			let carriedFromEarlierWeek: string | null = null;
			let skipBecauseCarriedToLaterWeek = false;
			let hasTitleCollision = false;

			for (const f of this.app.vault.getMarkdownFiles()) {
				const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
				if (!fm || !fm.id || fm.id === subtaskId) continue;

				const fmId = String(fm.id);
				if (fmId.startsWith(coursePrefix) && fmId.endsWith(`:subtask:${sectionNum}`)) {
					const otherParent = String(fm.parentId || f.basename);
					const otherWeekMatch = otherParent.match(/\bweek[\s-]*0?(\d+)\b/i) || String(fm.title || '').match(/\bweek[\s-]*0?(\d+)\b/i);
					const otherWeekNum = otherWeekMatch ? parseInt(otherWeekMatch[1], 10) : null;
					const otherDue = fm.due ? String(fm.due).slice(0, 10) : '';
					const curDue = assignment.weekEnd ? String(assignment.weekEnd).slice(0, 10) : '';

					const isEarlier =
						(currentWeekMatch !== null && otherWeekNum !== null && otherWeekNum < currentWeekMatch) ||
						(otherWeekNum === null && otherDue && curDue && otherDue < curDue);
					const isLater =
						(currentWeekMatch !== null && otherWeekNum !== null && otherWeekNum > currentWeekMatch) ||
						(otherWeekNum === null && otherDue && curDue && otherDue > curDue);

					const otherContent = await this.app.vault.read(f);
					const otherProbs: string[] = [];
					const otherChecked = new Set<string>();
					const probRegex = /^-\s*\[([xX ])\]\s*Problem\s+(.+?)(?:\s*✅.*)?$/gm;
					let m: RegExpExecArray | null;
					while ((m = probRegex.exec(otherContent)) !== null) {
						const pNum = m[2].trim();
						otherProbs.push(pNum);
						if (m[1].toLowerCase() === 'x') {
							otherChecked.add(pNum);
						}
					}

					const otherIsDone =
						String(fm.status || '').toLowerCase() === 'done' ||
						(otherProbs.length > 0 && otherChecked.size === otherProbs.length);

					if (isEarlier) {
						// Check if all earlier problems are included in the current week's problem list (carried-over topic)
						const isCarriedOverSubset =
							otherProbs.length > 0 && otherProbs.every((p) => rawProblemSet.has(p));

						if (!otherIsDone && isCarriedOverSubset) {
							// Carry over ("Sarkan Konu"): remove unfinished subtask from the earlier week and move to current week!
							for (const cp of otherChecked) carriedOverChecked.add(cp);
							carriedFromEarlierWeek = otherWeekNum !== null ? `Week ${otherWeekNum}` : 'önceki hafta';
							const otherSectionId = fmId.split(':')[2];
							const otherParentId = `section:${assignment.courseId}:${otherSectionId}`;
							for (const pf of this.app.vault.getMarkdownFiles()) {
								const pfm = this.app.metadataCache.getFileCache(pf)?.frontmatter;
								if (pfm && String(pfm.id) === otherParentId) {
									await this.unlinkChildFromParent(pf, f.basename);
									break;
								}
							}
							await this.app.vault.delete(f);
						} else {
							// Earlier subtask is either already 'done' OR had distinct problems (part 1 vs part 2)
							for (const p of otherProbs) earlierProblems.add(p);
							hasTitleCollision = true;
						}
					} else if (isLater) {
						// If a later week already has these exact problems and the current week's subtask is not done,
						// then this topic has already carried over to the later week.
						const otherProbSet = new Set(otherProbs);
						const allInLater = rawProblems.length > 0 && rawProblems.every((p) => otherProbSet.has(p));
						const currentIsDone =
							existingSubtask &&
							String(this.app.metadataCache.getFileCache(existingSubtask)?.frontmatter?.status || '').toLowerCase() === 'done';
						if (allInLater && !currentIsDone) {
							skipBecauseCarriedToLaterWeek = true;
						}
					}
				} else if (fm.title === baseSubtaskTitle) {
					hasTitleCollision = true;
				}
			}

			const effectiveProblems = earlierProblems.size > 0
				? rawProblems.filter((p: string) => !earlierProblems.has(p))
				: rawProblems;

			// Skip if carried over to a later week, or if all problems were already completed in an earlier week
			if (skipBecauseCarriedToLaterWeek || (earlierProblems.size > 0 && effectiveProblems.length === 0)) {
				if (existingSubtask) {
					await this.unlinkChildFromParent(parentFile, existingSubtask.basename);
					await this.app.vault.delete(existingSubtask);
				}
				continue;
			}

			const subtaskTitle = hasTitleCollision && weekPrefix ? `${weekPrefix}${baseSubtaskTitle}` : baseSubtaskTitle;

			const problemsList = effectiveProblems
				.map((p: string) => `- [${carriedOverChecked.has(p) ? 'x' : ' '}] Problem ${p}`)
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

			const finalSubtaskPath = existingSubtask ? existingSubtask.path : subtaskPath;
			if (!existingSubtask) {
				await this.app.vault.create(subtaskPath, renderedSubtask);
				if (carriedFromEarlierWeek) {
					moved.push({
						title: subtaskTitle,
						filePath: subtaskPath,
						detail: `${carriedFromEarlierWeek} → ${weekPrefixMatch ? weekPrefixMatch[1] : parentTitle} (Sarkan Konu taşındı)`
					});
				} else {
					added.push({
						title: subtaskTitle,
						filePath: subtaskPath
					});
				}
			} else {
				const subContent = await this.app.vault.read(existingSubtask);
				const expectedParentLink = `[[${parentBaseName}|${parentTitle}]]`;
				const mergedContent = this.mergeSuggestedProblemsContent(
					subContent,
					effectiveProblems,
					sectionNum,
					expectedParentLink,
					assignment.weekEnd || ''
				);
				if (mergedContent !== subContent) {
					await this.app.vault.modify(existingSubtask, mergedContent);
				}
				if (carriedFromEarlierWeek) {
					moved.push({
						title: subtaskTitle,
						filePath: finalSubtaskPath,
						detail: `${carriedFromEarlierWeek} → ${weekPrefixMatch ? weekPrefixMatch[1] : parentTitle} (Sarkan Konu taşındı)`
					});
				}
			}

			subtaskRefs.push({
				basename: existingSubtask ? existingSubtask.basename : fullSubtaskBasename,
				title: subtaskTitle
			});
		}

		if (subtaskRefs.length > 0) {
			await this.linkSubtasksInParent(parentFile, subtaskRefs);
		}

		return { added, moved };
	}

	async linkSubtasksInParent(parentFile: TFile, subtaskRefs: Array<{ basename: string; title: string }>) {
		for (const ref of subtaskRefs) {
			await this.linkChildToParent(parentFile, ref);
		}
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
			case 'pdf_assignment':
			case 'recitation':
			case 'pearson':
				return 'Assignment';
			case 'quiz':
				return 'Quiz';
			case 'hvp':
			case 'h5pactivity':
				return 'Interactive';
			default:
				return 'Assignment';
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
			'sectionId', 'weekStart', 'weekEnd', 'content', 'description', 'contentHash'
		];

		let result = template;
		for (const p of placeholders) {
			const value = data[p] !== null && data[p] !== undefined ? data[p] : '';
			const regex = new RegExp(`\\{\\{${p}\\}\\}`, 'g');
			result = result.replace(regex, String(value));
		}

		const descText = String(assignment.description || assignment.content || '').trim();
		if (
			assignment.type !== 'section' &&
			descText &&
			!template.includes('{{content}}') &&
			!template.includes('{{description}}') &&
			/^##\s+Description\s*$/m.test(result)
		) {
			const descBegin = '<!-- ODTUCLASS:DESCRIPTION:BEGIN -->';
			const descEnd = '<!-- ODTUCLASS:DESCRIPTION:END -->';
			result = result.replace(
				/^##\s+Description\s*$/m,
				`## Description\n\n${descBegin}\n${descText}\n${descEnd}`,
			);
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

		containerEl.createEl('h3', { text: 'Ders Slaytları (Course Slides Sync)' });

		new Setting(containerEl)
			.setName('Standart slayt dosya isimlendirmesi (Örn: "2026 Week 1a.pdf")')
			.setDesc('Açık olduğunda ODTUClass üzerindeki "CENG111-2026--Week1a.pdf" gibi ham isimler "2026 Week 1a.pdf" formatına dönüştürülür.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoFormatSlideNames !== false)
				.onChange(async (value) => {
					this.plugin.settings.autoFormatSlideNames = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Slaytı Bulunan Dersleri GitHub\'dan Tara')
			.setDesc('GitHub deponuzdaki slayt manifestosunu kontrol ederek slayt tespit edilen dersleri aşağıdaki listeye ekler.')
			.addButton(button => button
				.setButtonText('Dersleri Algıla')
				.onClick(async () => {
					const { githubOwner, githubRepo, githubToken } = this.plugin.settings;
					if (!githubOwner || !githubRepo || !githubToken) {
						new Notice('Lütfen önce GitHub ayarlarını doldurun.');
						return;
					}
					const manifest = await fetchSlideManifestFromGithub(githubOwner, githubRepo, githubToken);
					if (!manifest) {
						new Notice('GitHub üzerinde henüz slayt manifestosu (.odtuclass/slides/manifest.json) bulunamadı.');
						return;
					}
					const coursesMap: Record<string, { courseCode: string; courseName: string }> = {};
					if (manifest.courses && typeof manifest.courses === 'object') {
						for (const [k, v] of Object.entries(manifest.courses) as [string, any][]) {
							coursesMap[k] = { courseCode: k, courseName: v?.courseName || k };
						}
					}
					if (manifest.slides && typeof manifest.slides === 'object' && !Array.isArray(manifest.slides)) {
						for (const slide of Object.values(manifest.slides) as any[]) {
							if (!slide) continue;
							const code = String(slide.courseCode || 'CENG111').trim();
							const name = String(slide.courseName || code).trim();
							if (!coursesMap[code]) {
								coursesMap[code] = { courseCode: code, courseName: name };
							}
						}
					} else if (manifest.courseCode && Array.isArray(manifest.slides)) {
						coursesMap[manifest.courseCode] = {
							courseCode: manifest.courseCode,
							courseName: manifest.courseName || manifest.courseCode
						};
					}
					let added = 0;
					for (const [code, data] of Object.entries(coursesMap)) {
						if (!this.plugin.settings.courseSlideConfigs[code]) {
							this.plugin.settings.courseSlideConfigs[code] = {
								courseCode: code,
								courseName: data.courseName || code,
								enabled: true,
								targetFolder: `Courses/${code}/Slides`,
								prompted: true
							};
							added++;
						}
					}
					await this.plugin.saveSettings();
					this.display();
					new Notice(added > 0 ? `${added} yeni ders eklendi.` : `Tüm slaytlı dersler (${Object.keys(coursesMap).join(', ') || 'yok'}) zaten listede.`);
				}));

		const configs = this.plugin.settings.courseSlideConfigs || {};
		for (const [courseCode, cfg] of Object.entries(configs)) {
			new Setting(containerEl)
				.setName(`${courseCode} Slayt Senkronizasyonu`)
				.setDesc(`${cfg.courseName || courseCode} dersinin slaytları için hedef Vault klasörü`)
				.addToggle(toggle => toggle
					.setTooltip('Bu dersin slaytlarını senkronize et')
					.setValue(cfg.enabled)
					.onChange(async (value) => {
						cfg.enabled = value;
						cfg.prompted = true;
						await this.plugin.saveSettings();
					}))
				.addText(text => text
					.setPlaceholder(`Courses/${courseCode}/Slides`)
					.setValue(cfg.targetFolder)
					.onChange(async (value) => {
						cfg.targetFolder = value.trim().replace(/^\/+|\/+$/g, '') || `Courses/${courseCode}/Slides`;
						cfg.prompted = true;
						await this.plugin.saveSettings();
					}))
				.addExtraButton(btn => btn
					.setIcon('trash')
					.setTooltip('Bu dersin slayt ayarını kaldır')
					.onClick(async () => {
						delete this.plugin.settings.courseSlideConfigs[courseCode];
						await this.plugin.saveSettings();
						this.display();
					}));
		}

		let newCourseCode = '';
		let newCourseFolder = '';
		new Setting(containerEl)
			.setName('Manuel Ders Slayt Klasörü Ekle')
			.setDesc('Yeni bir ders kodu (örn: MATH119) ve hedef klasör (örn: Courses/MATH119/Slides) ekleyin')
			.addText(text => text
				.setPlaceholder('Ders Kodu (örn: MATH119)')
				.onChange(val => {
					newCourseCode = val.trim().toUpperCase().replace(/\s+/g, '');
				}))
			.addText(text => text
				.setPlaceholder('Hedef Klasör (örn: Courses/MATH119/Slides)')
				.onChange(val => {
					newCourseFolder = val.trim().replace(/^\/+|\/+$/g, '');
				}))
			.addButton(btn => btn
				.setButtonText('Ekle')
				.onClick(async () => {
					if (!newCourseCode) {
						new Notice('Lütfen bir ders kodu girin.');
						return;
					}
					this.plugin.settings.courseSlideConfigs[newCourseCode] = {
						courseCode: newCourseCode,
						courseName: newCourseCode,
						enabled: true,
						targetFolder: newCourseFolder || `Courses/${newCourseCode}/Slides`,
						prompted: true
					};
					await this.plugin.saveSettings();
					this.display();
				}));

		// =========================================================================
		// Senkronizasyon Geçmişi (Sync History)
		// =========================================================================
		containerEl.createEl('h3', { text: '🕒 Senkronizasyon Geçmişi (Sync History)' });

		new Setting(containerEl)
			.setName('Çekme ve Görev Geçmişi')
			.setDesc('Her senkronizasyonda hangi ders/hafta altına hangi ödevlerin, alt görevlerin veya slaytların eklendiğini gösterir.')
			.addButton(btn => btn
				.setButtonText('Vault\'tan Geçmişi Yenile')
				.setTooltip('processed.json ve mevcut görev dosyalarından geçmiş kayıtları yeniden oluşturur')
				.onClick(async () => {
					const count = await this.plugin.seedSyncHistoryFromVault(true);
					this.display();
					new Notice(`Senkronizasyon geçmişi yenilendi (${count} geçmiş oturum bulundu).`);
				}))
			.addButton(btn => btn
				.setButtonText('Geçmişi Temizle')
				.setWarning()
				.onClick(async () => {
					this.plugin.settings.syncHistory = [];
					await this.plugin.saveSettings();
					this.display();
					new Notice('Senkronizasyon geçmişi temizlendi.');
				}));

		const historyContainer = containerEl.createDiv({ cls: 'odtuclass-sync-history-container' });
		historyContainer.style.display = 'flex';
		historyContainer.style.flexDirection = 'column';
		historyContainer.style.gap = '10px';
		historyContainer.style.marginTop = '8px';

		const renderHistoryList = () => {
			historyContainer.empty();
			const history = this.plugin.settings.syncHistory || [];

			if (history.length === 0) {
				const emptyEl = historyContainer.createDiv();
				emptyEl.style.padding = '12px 14px';
				emptyEl.style.borderRadius = '8px';
				emptyEl.style.background = 'var(--background-secondary)';
				emptyEl.style.color = 'var(--text-muted)';
				emptyEl.style.fontSize = '0.9em';
				emptyEl.setText('Henüz kaydedilmiş bir senkronizasyon geçmişi yok. "Sync ODTUClass" veya "Vault\'tan Geçmişi Yenile" butonuna tıklayabilirsiniz.');
				return;
			}

			history.forEach((entry, idx) => {
				const detailsEl = historyContainer.createEl('details');
				if (idx === 0) {
					detailsEl.open = true;
				}
				detailsEl.style.border = '1px solid var(--background-modifier-border)';
				detailsEl.style.borderRadius = '8px';
				detailsEl.style.background = 'var(--background-secondary)';
				detailsEl.style.padding = '8px 12px';

				const summaryEl = detailsEl.createEl('summary');
				summaryEl.style.cursor = 'pointer';
				summaryEl.style.display = 'flex';
				summaryEl.style.flexWrap = 'wrap';
				summaryEl.style.alignItems = 'center';
				summaryEl.style.justifyContent = 'space-between';
				summaryEl.style.gap = '8px';
				summaryEl.style.fontWeight = '600';

				const leftTitle = summaryEl.createSpan();
				let formattedDate = entry.timestamp;
				try {
					const d = new Date(entry.timestamp);
					if (!Number.isNaN(d.getTime())) {
						formattedDate = new Intl.DateTimeFormat('tr-TR', {
							timeZone: 'Europe/Istanbul',
							day: '2-digit',
							month: 'short',
							year: 'numeric',
							hour: '2-digit',
							minute: '2-digit'
						}).format(d);
					}
				} catch {}

				const sourceLabel =
					entry.source === 'github'
						? 'GitHub Sync'
						: entry.source === 'local'
							? 'Yerel Sync'
							: 'Önceki Sync Kaydı';
				leftTitle.setText(`📅 ${formattedDate} — ${sourceLabel}`);

				const badgesWrap = summaryEl.createSpan();
				badgesWrap.style.display = 'inline-flex';
				badgesWrap.style.flexWrap = 'wrap';
				badgesWrap.style.gap = '6px';
				badgesWrap.style.fontSize = '0.8em';
				badgesWrap.style.fontWeight = '500';

				const makeBadge = (text: string, bg: string, color: string) => {
					const b = badgesWrap.createSpan({ text });
					b.style.padding = '2px 8px';
					b.style.borderRadius = '999px';
					b.style.background = bg;
					b.style.color = color;
				};

				const st = entry.stats || {
					created: 0,
					updated: 0,
					moved: 0,
					slidesDownloaded: 0,
					slidesReplaced: 0,
					filtered: 0,
					skipped: 0,
					failed: 0
				};

				if (st.created > 0) {
					makeBadge(`+${st.created} eklendi`, 'rgba(46, 160, 67, 0.2)', 'var(--text-success, #3fb950)');
				}
				if (st.updated > 0) {
					makeBadge(`↻ ${st.updated} güncellendi`, 'rgba(56, 139, 253, 0.2)', 'var(--text-accent)');
				}
				if (st.moved > 0) {
					makeBadge(`↪ ${st.moved} taşındı`, 'rgba(210, 153, 34, 0.2)', 'var(--text-warning, #d29922)');
				}
				if ((st.slidesDownloaded || 0) + (st.slidesReplaced || 0) > 0) {
					makeBadge(
						`📊 ${(st.slidesDownloaded || 0) + (st.slidesReplaced || 0)} slayt`,
						'rgba(163, 113, 247, 0.2)',
						'var(--text-accent)'
					);
				}
				if (st.filtered > 0) {
					makeBadge(`🛡️ ${st.filtered} filtrelendi`, 'var(--background-modifier-hover)', 'var(--text-muted)');
				}
				if (st.skipped > 0 && entry.items.length === 0) {
					makeBadge(`⏭️ ${st.skipped} değişiklik yok`, 'var(--background-modifier-hover)', 'var(--text-muted)');
				}
				if (st.failed > 0) {
					makeBadge(`⚠️ ${st.failed} hata`, 'rgba(248, 81, 73, 0.2)', 'var(--text-error)');
				}

				const bodyEl = detailsEl.createDiv();
				bodyEl.style.marginTop = '10px';
				bodyEl.style.paddingTop = '8px';
				bodyEl.style.borderTop = '1px solid var(--background-modifier-border)';
				bodyEl.style.display = 'flex';
				bodyEl.style.flexDirection = 'column';
				bodyEl.style.gap = '6px';

				if (!entry.items || entry.items.length === 0) {
					const noChangeEl = bodyEl.createDiv();
					noChangeEl.style.color = 'var(--text-muted)';
					noChangeEl.style.fontSize = '0.88em';
					noChangeEl.setText(
						`Bu çekmede yeni veya güncellenen bir ödev/slayt bulunmadı (${st.skipped || 0} mevcut öğe kontrol edildi).`
					);
				} else {
					for (const item of entry.items) {
						const row = bodyEl.createDiv();
						row.style.display = 'flex';
						row.style.flexWrap = 'wrap';
						row.style.alignItems = 'baseline';
						row.style.gap = '6px';
						row.style.fontSize = '0.88em';
						row.style.padding = '3px 4px';
						row.style.borderRadius = '4px';

						const iconMap: Record<string, string> = {
							created: '✅',
							updated: '🔄',
							moved: '↪',
							slide: '📊',
							filtered: '🛡️'
						};
						row.createSpan({ text: iconMap[item.action] || '•' });

						if (item.courseCode) {
							const courseBadge = row.createSpan({ text: item.courseCode });
							courseBadge.style.fontSize = '0.82em';
							courseBadge.style.fontWeight = '600';
							courseBadge.style.padding = '1px 6px';
							courseBadge.style.borderRadius = '4px';
							courseBadge.style.background = 'var(--background-primary)';
							courseBadge.style.border = '1px solid var(--background-modifier-border)';
						}

						if (item.filePath) {
							const linkEl = row.createEl('a', {
								text: item.title,
								href: '#'
							});
							linkEl.style.fontWeight = '500';
							linkEl.style.cursor = 'pointer';
							linkEl.addEventListener('click', async (ev) => {
								ev.preventDefault();
								const target = this.app.vault.getAbstractFileByPath(item.filePath!);
								if (target && target instanceof TFile) {
									// Close settings modal and open the file
									(this.app as any).setting?.close?.();
									await this.app.workspace.getLeaf(false).openFile(target);
								} else {
									new Notice(`Dosya bulunamadı (taşınmış veya silinmiş olabilir): ${item.filePath}`);
								}
							});
						} else {
							const titleSpan = row.createSpan({ text: item.title });
							titleSpan.style.fontWeight = '500';
						}

						const metaParts: string[] = [];
						if (item.parentTitle && item.parentTitle !== item.courseCode) {
							metaParts.push(`→ ${item.parentTitle}`);
						}
						if (item.detail) {
							metaParts.push(item.detail);
						}
						if (metaParts.length > 0) {
							const metaSpan = row.createSpan({ text: `(${metaParts.join(' • ')})` });
							metaSpan.style.color = 'var(--text-muted)';
							metaSpan.style.fontSize = '0.85em';
						}
					}
				}
			});
		};

		if (!this.plugin.settings.syncHistory || this.plugin.settings.syncHistory.length === 0) {
			this.plugin.seedSyncHistoryFromVault(false).then((seeded) => {
				renderHistoryList();
			});
		} else {
			renderHistoryList();
		}
	}
}

