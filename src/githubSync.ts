import { Notice, requestUrl } from 'obsidian';

export interface ProcessedState {
	[id: string]: { processedAt: string };
}

export async function loadProcessedState(adapter: any): Promise<ProcessedState> {
	const path = '.odtuclass/processed.json';
	if (await adapter.exists(path)) {
		try {
			const content = await adapter.read(path);
			return JSON.parse(content);
		} catch (e) {
			console.error("[ODTUClass] Error parsing processed.json. Returning empty state.", e);
			return {};
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

	const state = await loadProcessedState(plugin.app.vault.adapter);
	let newCount = 0;
	let skipCount = 0;
	let processedAny = false;

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

			// In Phase 1 we just discover, parse, but do not create markdown.
			// Let's fetch the actual JSON to confirm the ID (since it's cheap for dry-run if there are not many).
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
				const realId = data.id || possibleId;

				if (state[realId]) {
					skipCount++;
					continue;
				}

				newCount++;
				console.log(`[ODTUClass] DRY-RUN: Discovered new task ID: ${realId}`);
				
				// Simulate successful process for Phase 1 by updating state (or we can just skip updating state to keep it repeatable).
				// For Phase 1, we DO NOT write to state yet, to allow repeated testing.
			} catch (e) {
				console.error(`[ODTUClass] Error parsing JSON for ${item.name}:`, e.message);
			}
		}
	}

	new Notice(`ODTUClass Sync: Found ${newCount} new events. Skipped ${skipCount} processed events. (DRY-RUN)`);
}
