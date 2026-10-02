import { Notice, requestUrl } from 'obsidian';

export interface ProcessedState {
	[id: string]: { processedAt: string };
}

export async function loadProcessedState(adapter: any): Promise<ProcessedState> {
	const path = '.odtuclass/processed.json';
	if (await adapter.exists(path)) {
		try {
			const content = await adapter.read(path);
			const parsed = JSON.parse(content);
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

			if (state[possibleId]) {
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

				if (!realId || realId !== possibleId) {
					console.error(`[ODTUClass] Security/Consistency warning: Filename ID '${possibleId}' does not match JSON real ID '${realId}'. Skipping.`);
					failCount++;
					continue;
				}

				if (state[realId]) {
					skipCount++;
					continue;
				}

				await plugin.processAssignment(data, true); // true = skipIfExists

				// Successfully processed, add to state
				state[realId] = { processedAt: new Date().toISOString() };
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

	new Notice(`ODTUClass Sync: ${createdCount} created, ${skipCount} skipped, ${failCount} failed.`);
}
