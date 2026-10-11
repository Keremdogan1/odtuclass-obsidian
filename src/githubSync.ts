import { App, Modal, Notice, Setting, requestUrl } from 'obsidian';

export interface ProcessedState {
	[id: string]: {
		processedAt: string;
		contentHash?: string;
		status?: string;
		openAt?: string;
		dueAt?: string;
	};
}

export interface CourseSlideConfig {
	courseCode: string;
	courseName: string;
	enabled: boolean;
	targetFolder: string;
	prompted?: boolean;
}

export function formatStandardSlideFilename(slide: {
	filename: string;
	formattedFilename?: string | null;
	weekKey?: string | null;
	title?: string | null;
}): string {
	if (slide.formattedFilename && typeof slide.formattedFilename === 'string') {
		return slide.formattedFilename.trim();
	}
	const rawName = String(slide.filename || '').trim();
	const combined = `${rawName} ${slide.title || ''}`;
	const yearMatch = combined.match(/\b(20\d{2})\b/);
	const year = yearMatch ? yearMatch[1] : '2026';

	let weekKey = slide.weekKey ? String(slide.weekKey).toLowerCase().trim() : '';
	if (!weekKey) {
		const wkMatch = combined.match(/week\s*[-_]*0*(\d{1,2}[a-d]?)(?![0-9a-z])/i);
		if (wkMatch) {
			weekKey = wkMatch[1].toLowerCase();
		}
	}

	if (weekKey) {
		const isPrelecture = /pre-?lecture/i.test(combined);
		const suffix = isPrelecture ? ' Prelecture' : '';
		return `${year} Week ${weekKey}${suffix}.pdf`;
	}

	return rawName.toLowerCase().endsWith('.pdf') ? rawName : `${rawName}.pdf`;
}

export class CourseSlidePromptModal extends Modal {
	private plugin: any;
	private courseCode: string;
	private courseName: string;
	private slideCount: number;
	private resolvePromise!: (config: CourseSlideConfig) => void;
	private resolved = false;
	private enabled = true;
	private targetFolder: string;

	constructor(
		app: App,
		plugin: any,
		courseCode: string,
		courseName: string,
		slideCount: number,
		defaultFolder?: string
	) {
		super(app);
		this.plugin = plugin;
		this.courseCode = courseCode;
		this.courseName = courseName || courseCode;
		this.slideCount = slideCount;
		this.targetFolder = defaultFolder || `Courses/${courseCode}/Slides`;
	}

	waitForDecision(): Promise<CourseSlideConfig> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', {
			text: `Yeni Ders Slaytları Tespit Edildi (${this.courseCode})`,
		});

		contentEl.createEl('p', {
			text: `"${this.courseName}" dersi için ODTUClass üzerinde ${this.slideCount} adet ders slaytı (PDF) tespit edildi. Bu dersin slaytlarının otomatik olarak indirileceği Vault klasörünü seçebilirsiniz:`,
		});

		new Setting(contentEl)
			.setName('Slayt Senkronizasyonunu Etkinleştir')
			.setDesc('Bu ders için yeni yüklenen slaytları otomatik indir')
			.addToggle((toggle) =>
				toggle.setValue(this.enabled).onChange((val) => {
					this.enabled = val;
				})
			);

		new Setting(contentEl)
			.setName('Hedef Slayt Klasörü')
			.setDesc(`Örn: Courses/${this.courseCode}/Slides`)
			.addText((text) =>
				text
					.setPlaceholder(`Courses/${this.courseCode}/Slides`)
					.setValue(this.targetFolder)
					.onChange((val) => {
						this.targetFolder = val.trim() || `Courses/${this.courseCode}/Slides`;
					})
			);

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText('Bu Ders İçin İndirme')
					.onClick(async () => {
						this.enabled = false;
						await this.saveAndFinish();
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText('Kaydet ve Senkronize Et')
					.setCta()
					.onClick(async () => {
						await this.saveAndFinish();
					})
			);
	}

	private async saveAndFinish() {
		if (this.resolved) return;
		this.resolved = true;
		const config: CourseSlideConfig = {
			courseCode: this.courseCode,
			courseName: this.courseName,
			enabled: this.enabled,
			targetFolder: this.targetFolder,
			prompted: true,
		};
		if (!this.plugin.settings.courseSlideConfigs) {
			this.plugin.settings.courseSlideConfigs = {};
		}
		this.plugin.settings.courseSlideConfigs[this.courseCode] = config;
		await this.plugin.saveSettings();
		this.resolvePromise(config);
		this.close();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		if (!this.resolved) {
			this.resolved = true;
			const fallbackConfig: CourseSlideConfig = {
				courseCode: this.courseCode,
				courseName: this.courseName,
				enabled: this.enabled,
				targetFolder: this.targetFolder,
				prompted: true,
			};
			this.resolvePromise(fallbackConfig);
		}
	}
}

export async function loadProcessedState(adapter: any): Promise<ProcessedState> {
	const path = '.odtuclass/processed.json';
	if (await adapter.exists(path)) {
		try {
			const content = await adapter.read(path);
			const cleanContent = content.replace(/^\uFEFF/, '');
			const parsed = JSON.parse(cleanContent);
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				throw new Error("State is not a valid JSON object");
			}
			return parsed;
		} catch (e) {
			console.error("[ODTUClass] Error parsing processed.json:", e);
			throw new Error("Malformed processed.json");
		}
	}
	return {};
}

export async function saveProcessedState(adapter: any, state: ProcessedState): Promise<void> {
	const path = '.odtuclass/processed.json';
	const dir = '.odtuclass';
	if (!(await adapter.exists(dir))) {
		await adapter.mkdir(dir);
	}
	await adapter.write(path, JSON.stringify(state, null, 2));
}

export async function syncFromGithub(plugin: any): Promise<void> {
	new Notice("ODTUClass: Syncing from GitHub...");
	const owner = plugin.settings.githubOwner;
	const repo = plugin.settings.githubRepo;
	const token = plugin.settings.githubToken;

	if (!token) {
		new Notice("ODTUClass: GitHub token is not set!");
		return;
	}

	const url = `https://api.github.com/repos/${owner}/${repo}/contents/.odtuclass/pending`;

	let items;
	try {
		const res = await requestUrl({
			url,
			method: 'GET',
			headers: {
				"Authorization": `Bearer ${token}`,
				"Accept": "application/vnd.github.v3+json",
				"User-Agent": "Obsidian-ODTUClass-Plugin"
			}
		});
		
		if (res.status !== 200) {
			new Notice(`ODTUClass: GitHub API returned status ${res.status}`);
			console.error(`[ODTUClass] GitHub API error: ${res.status}`);
			return;
		}
		items = res.json;
	} catch (e) {
		new Notice("ODTUClass: Network error while fetching from GitHub.");
		console.error("[ODTUClass] GitHub fetch error:", e.message);
		return;
	}

	if (!Array.isArray(items)) {
		new Notice("ODTUClass: Invalid response from GitHub API.");
		return;
	}

	let state;
	try {
		state = await loadProcessedState(plugin.app.vault.adapter);
	} catch (e) {
		new Notice("ODTUClass: Sync aborted! processed.json is malformed. Check console.");
		return;
	}
	let createdCount = 0;
	let skipCount = 0;
	let failCount = 0;
	let stateChanged = false;

	for (const item of items) {
		if (item.name.endsWith('.json')) {
			const idStr = item.name.replace('.json', '');

			try {
				const fileRes = await requestUrl({
					url: item.download_url,
					method: 'GET',
					headers: {
						"Authorization": `Bearer ${token}`,
						"User-Agent": "Obsidian-ODTUClass-Plugin"
					}
				});
				const data = fileRes.json;
				const realId = data.id;

				const sanitizedRealId = realId ? realId.replace(/[^a-zA-Z0-9._-]+/g, '-') : '';

				if (!realId || sanitizedRealId !== idStr) {
					console.error(`[ODTUClass] Security/Consistency warning: Filename ID '${idStr}' does not match JSON real ID '${realId}'. Skipping.`);
					failCount++;
					continue;
				}

				const existingEntry = state[realId];

				if (existingEntry) {
					const sameHash = !data.contentHash || existingEntry.contentHash === data.contentHash;
					const sameStatus = !data.status || existingEntry.status === data.status;
					const sameOpen = !data.openAt || existingEntry.openAt === data.openAt;
					const sameDue = !data.dueAt || existingEntry.dueAt === data.dueAt;

					if (sameHash && sameStatus && sameOpen && sameDue) {
						skipCount++;
						continue;
					}
				}

				await plugin.processAssignment(data, false);

				state[realId] = {
					processedAt: new Date().toISOString(),
					...(data.contentHash ? { contentHash: data.contentHash } : {}),
					...(data.status ? { status: data.status } : {}),
					...(data.openAt ? { openAt: data.openAt } : {}),
					...(data.dueAt ? { dueAt: data.dueAt } : {})
				};
				stateChanged = true;
				createdCount++;

			} catch (e) {
				console.error(`[ODTUClass] Error processing JSON for ${item.name}:`, e.message);
				failCount++;
			}
		}
	}

	if (stateChanged) {
		await saveProcessedState(plugin.app.vault.adapter, state);
	}

	let slideStats = { downloaded: 0, replaced: 0 };
	try {
		slideStats = await syncAllCourseSlidesFromGithub(plugin, owner, repo, token);
	} catch (slideErr) {
		console.warn("[ODTUClass] Error syncing course slides:", slideErr);
	}

	const slideMsg =
		slideStats.downloaded > 0 || slideStats.replaced > 0
			? ` | Slides: ${slideStats.downloaded} downloaded, ${slideStats.replaced} replaced`
			: '';

	new Notice(`ODTUClass Sync: ${createdCount} updated/created, ${skipCount} skipped, ${failCount} failed${slideMsg}.`);
}

export async function fetchSlideManifestFromGithub(
	owner: string,
	repo: string,
	token: string
): Promise<any | null> {
	const manifestUrls = [
		`https://api.github.com/repos/${owner}/${repo}/contents/.odtuclass/slides/manifest.json`,
		`https://api.github.com/repos/${owner}/${repo}/contents/.odtuclass/slides/CENG111/manifest.json`,
	];

	for (const manifestApiUrl of manifestUrls) {
		try {
			const manifestRes = await requestUrl({
				url: manifestApiUrl,
				method: 'GET',
				headers: {
					"Authorization": `Bearer ${token}`,
					"Accept": "application/vnd.github.v3+json",
					"User-Agent": "Obsidian-ODTUClass-Plugin"
				},
				throw: false
			});
			if (manifestRes && manifestRes.status === 200 && manifestRes.json?.download_url) {
				const rawManifestRes = await requestUrl({
					url: manifestRes.json.download_url,
					method: 'GET',
					headers: {
						"Authorization": `Bearer ${token}`,
						"User-Agent": "Obsidian-ODTUClass-Plugin"
					}
				});
				if (rawManifestRes?.json?.slides) {
					return rawManifestRes.json;
				}
			}
		} catch {
			// continue
		}
	}
	return null;
}

export async function syncAllCourseSlidesFromGithub(
	plugin: any,
	owner: string,
	repo: string,
	token: string
): Promise<{ downloaded: number; replaced: number }> {
	const adapter = plugin.app.vault.adapter;
	const manifest = await fetchSlideManifestFromGithub(owner, repo, token);

	if (!manifest || typeof manifest.slides !== 'object') {
		return { downloaded: 0, replaced: 0 };
	}

	// Group slides by courseCode
	const byCourse = new Map<string, { courseName: string; slides: any[] }>();
	for (const slide of Object.values(manifest.slides) as any[]) {
		if (!slide || !slide.filename) continue;
		const courseCode = String(slide.courseCode || 'CENG111').trim();
		const courseName = String(slide.courseName || courseCode).trim();
		if (!byCourse.has(courseCode)) {
			byCourse.set(courseCode, { courseName, slides: [] });
		}
		byCourse.get(courseCode)!.slides.push(slide);
	}

	let downloaded = 0;
	let replaced = 0;

	if (!plugin.settings.courseSlideConfigs) {
		plugin.settings.courseSlideConfigs = {};
	}

	for (const [courseCode, group] of byCourse.entries()) {
		let config: CourseSlideConfig | undefined = plugin.settings.courseSlideConfigs[courseCode];

		if (!config || !config.prompted) {
			const modal = new CourseSlidePromptModal(
				plugin.app,
				plugin,
				courseCode,
				group.courseName,
				group.slides.length,
				config?.targetFolder || `Courses/${courseCode}/Slides`
			);
			config = await modal.waitForDecision();
		}

		if (!config.enabled) {
			continue;
		}

		const slidesDir = (config.targetFolder || `Courses/${courseCode}/Slides`).replace(/\/+$/, '');
		if (!(await adapter.exists(slidesDir))) {
			await plugin.createFolderRecursive(slidesDir);
		}

		for (const slide of group.slides) {
			const rawFilename = String(slide.filename);
			const targetFilename =
				plugin.settings.autoFormatSlideNames !== false
					? formatStandardSlideFilename(slide)
					: rawFilename;
			const weekKey = slide.weekKey ? String(slide.weekKey).toLowerCase() : '';
			const targetPath = `${slidesDir}/${targetFilename}`;
			const legacyRawPath = `${slidesDir}/${rawFilename}`;

			// If legacy unformatted file exists (e.g. CENG111-2026--Week1a.pdf) and has no .annot.json, rename it to targetPath ("2026 Week 1a.pdf")
			if (
				legacyRawPath !== targetPath &&
				(await adapter.exists(legacyRawPath)) &&
				!(await adapter.exists(`${legacyRawPath}.annot.json`))
			) {
				if (!(await adapter.exists(targetPath))) {
					const buf = await adapter.readBinary(legacyRawPath);
					await adapter.writeBinary(targetPath, buf);
				}
				await adapter.remove(legacyRawPath);
			}

			// Do not overwrite if an annotated version already exists
			if (
				(await adapter.exists(`${targetPath}.annot.json`)) ||
				(await adapter.exists(`${legacyRawPath}.annot.json`))
			) {
				continue;
			}

			let shouldDownload = !(await adapter.exists(targetPath));
			let isSameNameReplacement = false;
			if (!shouldDownload && slide.filesize) {
				try {
					const stat = await adapter.stat(targetPath);
					if (stat && typeof stat.size === 'number' && stat.size !== Number(slide.filesize)) {
						shouldDownload = true;
						isSameNameReplacement = true;
					}
				} catch {}
			}

			if (shouldDownload) {
				const fileApiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/.odtuclass/slides/${encodeURIComponent(courseCode)}/${encodeURIComponent(rawFilename)}`;
				const pdfRes = await requestUrl({
					url: fileApiUrl,
					method: 'GET',
					headers: {
						"Authorization": `Bearer ${token}`,
						"Accept": "application/vnd.github.v3.raw",
						"User-Agent": "Obsidian-ODTUClass-Plugin"
					},
					throw: false
				});

				if (pdfRes && pdfRes.status === 200 && pdfRes.arrayBuffer) {
					await adapter.writeBinary(targetPath, pdfRes.arrayBuffer);
					downloaded++;
					if (isSameNameReplacement) {
						replaced++;
					}
				}
			}

			if (weekKey && !/pre-?lecture/i.test(targetFilename) && (await adapter.exists(targetPath))) {
				const old2024Path = `${slidesDir}/2024 Week ${weekKey}.pdf`;
				const old2024AnnotPath = `${old2024Path}.annot.json`;
				if (
					old2024Path !== targetPath &&
					(await adapter.exists(old2024Path)) &&
					!(await adapter.exists(old2024AnnotPath))
				) {
					await adapter.remove(old2024Path);
					replaced++;
				}
			}

			// Replace old numbered slides (e.g. "2. The Cell & Cytoskeleton.pdf" → "2. Cell.pdf")
			const numMatch = targetFilename.match(/^(\d+)\.\s+/);
			if (numMatch && (await adapter.exists(targetPath))) {
				const numPrefix = numMatch[1];
				try {
					const files = await adapter.list(slidesDir);
					for (const existingFile of (files.files || [])) {
						const baseName = existingFile.split('/').pop() || '';
						if (baseName === targetFilename) continue;
						const existingNumMatch = baseName.match(/^(\d+)\.\s+.*\.pdf$/i);
						if (
							existingNumMatch &&
							existingNumMatch[1] === numPrefix &&
							!(await adapter.exists(`${existingFile}.annot.json`))
						) {
							await adapter.remove(existingFile);
							replaced++;
						}
					}
				} catch {}
			}
		}
	}

	return { downloaded, replaced };
}
