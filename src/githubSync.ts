import { Notice, requestUrl } from 'obsidian';

export interface ProcessedState {
	[id: string]: {
		processedAt: string;
		contentHash?: string;
	};
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
		console.error("[ODTUClass] GitHub fetch error:", e.message); // Never log the token
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
			// e.g. assignment-3533-28451.json -> assignment:3533:28451
			const idStr = item.name.replace('.json', '');
			const idMatch = idStr.match(/^([a-z]+)-(\d+)-(\d+)$/);
			let possibleId = idStr;
			if (idMatch) {
				possibleId = `${idMatch[1]}:${idMatch[2]}:${idMatch[3]}`;
			}

			const isPossibleSection = possibleId.startsWith('section:');

			if (state[possibleId] && !isPossibleSection) {
				skipCount++;
				continue;
			}

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

				const isSection = realId.startsWith('section:');
				const existingEntry = state[realId];

				// Assignments remain create-only: an existing state entry means skip.
				if (!isSection && existingEntry) {
					skipCount++;
					continue;
				}

				// Sections are mutable: only skip when the incoming content is unchanged.
				if (
					isSection &&
					existingEntry?.contentHash &&
					existingEntry.contentHash === data.contentHash
				) {
					skipCount++;
					continue;
				}

				await plugin.processAssignment(data, true); // true = skipIfExists

				// Successfully processed, add/update state.
				state[realId] = {
					processedAt: new Date().toISOString(),
					...(isSection && data.contentHash
						? { contentHash: data.contentHash }
						: {})
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
		slideStats = await syncCeng111SlidesFromGithub(plugin, owner, repo, token);
	} catch (slideErr) {
		console.warn("[ODTUClass] Error syncing CENG 111 slides:", slideErr);
	}

	const slideMsg =
		slideStats.downloaded > 0 || slideStats.replaced > 0
			? ` | Slides: ${slideStats.downloaded} downloaded, ${slideStats.replaced} 2024 slide(s) replaced`
			: '';

	new Notice(`ODTUClass Sync: ${createdCount} created, ${skipCount} skipped, ${failCount} failed${slideMsg}.`);
}

export async function syncCeng111SlidesFromGithub(
	plugin: any,
	owner: string,
	repo: string,
	token: string
): Promise<{ downloaded: number; replaced: number }> {
	const adapter = plugin.app.vault.adapter;
	const slidesDir = 'Courses/CENG111/Slides';

	const manifestApiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/.odtuclass/slides/CENG111/manifest.json`;
	let manifestRes;
	try {
		manifestRes = await requestUrl({
			url: manifestApiUrl,
			method: 'GET',
			headers: {
				"Authorization": `Bearer ${token}`,
				"Accept": "application/vnd.github.v3+json",
				"User-Agent": "Obsidian-ODTUClass-Plugin"
			},
			throw: false
		});
	} catch {
		return { downloaded: 0, replaced: 0 };
	}

	if (!manifestRes || manifestRes.status !== 200 || !manifestRes.json?.download_url) {
		return { downloaded: 0, replaced: 0 };
	}

	const rawManifestRes = await requestUrl({
		url: manifestRes.json.download_url,
		method: 'GET',
		headers: {
			"Authorization": `Bearer ${token}`,
			"User-Agent": "Obsidian-ODTUClass-Plugin"
		}
	});

	const manifest = rawManifestRes.json;
	if (!manifest || typeof manifest.slides !== 'object') {
		return { downloaded: 0, replaced: 0 };
	}

	if (!(await adapter.exists(slidesDir))) {
		await plugin.createFolderRecursive(slidesDir);
	}

	let downloaded = 0;
	let replaced = 0;

	for (const slide of Object.values(manifest.slides) as any[]) {
		if (!slide || !slide.filename) continue;
		const filename = String(slide.filename);
		const weekKey = slide.weekKey ? String(slide.weekKey).toLowerCase() : '';
		const targetPath = `${slidesDir}/${filename}`;

		if (!(await adapter.exists(targetPath))) {
			const fileApiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/.odtuclass/slides/CENG111/${encodeURIComponent(filename)}`;
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
			}
		}

		if (weekKey && (await adapter.exists(targetPath))) {
			const old2024Path = `${slidesDir}/2024 Week ${weekKey}.pdf`;
			const old2024AnnotPath = `${old2024Path}.annot.json`;
			if ((await adapter.exists(old2024Path)) && !(await adapter.exists(old2024AnnotPath))) {
				await adapter.remove(old2024Path);
				replaced++;
			}
		}
	}

	return { downloaded, replaced };
}

