import type {
	DomainHealth,
	DomainCheck,
	CheckState,
} from "../../../shared/domain-health";
import { StatusPill } from "./PortalShell";
const labels: Record<CheckState, string> = {
	passed: "已通过",
	missing: "待配置",
	permission: "权限不足",
	unknown: "尚未验证",
	error: "检测失败",
	warning: "需核对",
};
export function HealthState({ state }: { state: CheckState }) {
	return (
		<StatusPill
			tone={
				state === "passed"
					? "green"
					: ["missing", "permission", "error", "warning"].includes(state)
						? "amber"
						: "neutral"
			}
		>
			{labels[state]}
		</StatusPill>
	);
}
function CheckRow({ check: x }: { check: DomainCheck }) {
	return (
		<details className="compact-health-item">
			<summary>
				<span className="font-medium">{x.label}</span>
				<span className="compact-health-preview">{x.detail}</span>
				<HealthState state={x.state} />
			</summary>
			<div className="compact-health-detail">
				<p>{x.detail}</p>
				{!!x.records?.length && (
					<pre className="whitespace-pre-wrap break-all mt-2 rounded bg-kumo-recessed p-2">
						{x.records.join("\n")}
					</pre>
				)}
			</div>
		</details>
	);
}
function Group({ title, checks }: { title: string; checks: DomainCheck[] }) {
	if (!checks.length) return null;
	return (
		<details className="compact-health-group">
			<summary>
				{title}
				<span>{checks.length}</span>
			</summary>
			<div className="mt-2">
				{checks.map((x) => (
					<CheckRow key={x.id} check={x} />
				))}
			</div>
		</details>
	);
}
export default function DomainHealthView({ health }: { health: DomainHealth }) {
	const rank: Record<CheckState, number> = {
		error: 0,
		permission: 1,
		missing: 2,
		warning: 3,
		unknown: 4,
		passed: 5,
	};
	const issues = health.checks
		.filter((x) => !["passed", "unknown"].includes(x.state))
		.sort((a, b) => rank[a.state] - rank[b.state]);
	const unknown = health.checks.filter((x) => x.state === "unknown"),
		passed = health.checks.filter((x) => x.state === "passed");
	return (
		<div className="compact-health-view">
			<div className="compact-health-summary">
				<span>
					{issues.length ? `${issues.length} 项需要处理` : "暂无已确认异常"}
					{unknown.length ? ` · ${unknown.length} 项尚未验证` : ""}
				</span>
				<span>
					{new Date(health.checkedAt).toLocaleString("zh-CN", {
						month: "2-digit",
						day: "2-digit",
						hour: "2-digit",
						minute: "2-digit",
					})}
				</span>
			</div>
			{issues.slice(0, 3).map((x) => (
				<CheckRow key={x.id} check={x} />
			))}
			<Group title="其余待处理项目" checks={issues.slice(3)} />
			<Group title="尚未验证" checks={unknown} />
			<Group title="已通过项目" checks={passed} />
			<p className="text-[11px] text-kumo-subtle mt-3">
				点击项目查看原因和记录；检测通过不等于实际投递成功。
			</p>
		</div>
	);
}
