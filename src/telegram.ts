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

function truncate(value: string, maxLength: number): string {
	return value.length > maxLength
		? `${value.substring(0, maxLength - 1)}…`
		: value;
}

function buildDetails(event: CloudflareEvent, environment?: string): string[] {
	const meta = event.payload?.buildTriggerMetadata;
	const workerName = event.source?.workerName || meta?.repoName || "Worker";
	const lines = [`<b>Project:</b> <code>${escapeHtml(workerName)}</code>`];

	if (environment) lines.push(`<b>Environment:</b> ${environment}`);

	if (meta?.branch) lines.push(`<b>Branch:</b> <code>${escapeHtml(meta.branch)}</code>`);
	if (meta?.commitHash) {
		const shortHash = meta.commitHash.substring(0, 7);
		lines.push(`<b>Commit:</b> ${link(shortHash, getCommitUrl(event))}`);
	}
	if (meta?.commitMessage) {
		lines.push(
			`<b>Message:</b> ${escapeHtml(truncate(meta.commitMessage.trim(), 500))}`,
		);
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
	const dashboardUrl = getDashboardUrl(event);
	const lines: string[] = [];
	let actionUrl: string | null = null;
	let actionLabel = "Open build details";
	let environment: string | undefined;

	if (status.isSucceeded) {
		const production = isProductionBranch(
			event.payload?.buildTriggerMetadata?.branch,
		);
		environment = production ? "Production" : "Preview";
		lines.push(
			production
				? "✅ <b>Production deployment succeeded</b>"
				: "✅ <b>Preview deployment succeeded</b>",
		);
		actionUrl = production ? liveUrl || dashboardUrl : previewUrl || dashboardUrl;
		actionLabel = production ? "Open production deployment" : "Open preview deployment";
	} else if (status.isFailed) {
		environment = isProductionBranch(
			event.payload?.buildTriggerMetadata?.branch,
		)
			? "Production"
			: "Preview";
		lines.push("❌ <b>Build failed</b>");
		actionUrl = dashboardUrl;
		actionLabel = "Open build logs";
	} else if (status.isCancelled) {
		lines.push("⚠️ <b>Build cancelled</b>");
		actionUrl = dashboardUrl;
	} else {
		lines.push(`📢 ${escapeHtml(event.type || "Unknown event")}`);
	}

	lines.push("", ...buildDetails(event, environment));
	if (status.isFailed) {
		lines.push("", "<b>Error</b>", `<pre>${escapeHtml(extractBuildError(logs))}</pre>`);
	}
	if (actionUrl) lines.push("", `🔗 ${link(actionLabel, actionUrl)}`);

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
