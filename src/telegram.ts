/** Telegram message formatting and delivery for build notifications. */

import type { CloudflareEvent } from "./types";
import {
	extractAuthorName,
	extractBuildError,
	getBuildStatus,
	getCommitUrl,
	getDashboardUrl,
	isProductionBranch,
} from "./helpers";

export interface TelegramPayload {
	chat_id: string;
	text: string;
	parse_mode: "HTML";
	disable_web_page_preview: boolean;
}

interface TelegramResponse {
	ok: boolean;
	description?: string;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function link(label: string, url: string | null): string {
	return url
		? `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`
		: escapeHtml(label);
}

function buildContext(event: CloudflareEvent): string[] {
	const meta = event.payload?.buildTriggerMetadata;
	const lines: string[] = [];

	if (meta?.branch) lines.push(`<b>Branch:</b> <code>${escapeHtml(meta.branch)}</code>`);
	if (meta?.commitHash) {
		const shortHash = meta.commitHash.substring(0, 7);
		lines.push(`<b>Commit:</b> ${link(shortHash, getCommitUrl(event))}`);
	}

	const author = extractAuthorName(meta?.author);
	if (author) lines.push(`<b>Author:</b> ${escapeHtml(author)}`);

	return lines;
}

/** Builds Telegram-compatible HTML for a Workers Builds event. */
export function buildTelegramMessage(
	event: CloudflareEvent,
	previewUrl: string | null,
	liveUrl: string | null,
	logs: string[],
): string {
	const status = getBuildStatus(event);
	const workerName = escapeHtml(event.source?.workerName || "Worker");
	const dashboardUrl = getDashboardUrl(event);
	const lines: string[] = [];

	if (status.isSucceeded) {
		const production = isProductionBranch(
			event.payload?.buildTriggerMetadata?.branch,
		);
		lines.push(
			`${production ? "✅ <b>Production Deploy</b>" : "✅ <b>Preview Deploy</b>"}\n<b>${workerName}</b>`,
		);
		const targetUrl = production ? liveUrl || dashboardUrl : previewUrl || dashboardUrl;
		if (targetUrl) lines.push(link(production ? "View Worker" : "View Preview", targetUrl));
	} else if (status.isFailed) {
		lines.push(`❌ <b>Build Failed</b>\n<b>${workerName}</b>`);
		if (dashboardUrl) lines.push(link("View Logs", dashboardUrl));
	} else if (status.isCancelled) {
		lines.push(`⚠️ <b>Build Cancelled</b>\n<b>${workerName}</b>`);
		if (dashboardUrl) lines.push(link("View Build", dashboardUrl));
	} else {
		lines.push(`📢 ${escapeHtml(event.type || "Unknown event")}`);
	}

	lines.push(...buildContext(event));
	if (status.isFailed) {
		lines.push(`<pre>${escapeHtml(extractBuildError(logs))}</pre>`);
	}

	return lines.join("\n");
}

/** Sends a message via Telegram Bot API's sendMessage method. */
export async function sendTelegramNotification(
	botToken: string,
	chatId: string,
	text: string,
): Promise<void> {
	const payload: TelegramPayload = {
		chat_id: chatId,
		text,
		parse_mode: "HTML",
		disable_web_page_preview: true,
	};
	const response = await fetch(
		`https://api.telegram.org/bot${botToken}/sendMessage`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		},
	);

	let result: TelegramResponse | null = null;
	try {
		result = await response.json<TelegramResponse>();
	} catch {
		// A non-JSON response is handled by the status check below.
	}

	if (!response.ok || !result?.ok) {
		throw new Error(
			`Telegram API error (${response.status}): ${result?.description || "Unknown error"}`,
		);
	}
}
