import type { DomainHealth, CheckState } from "../../../shared/domain-health";
import { StatusPill } from "./PortalShell";
const labels: Record<CheckState, string> = {
	passed: "已通过",
	missing: "待配置",
	permission: "权限不足",
	unknown: "尚未验证",
	error: "检测/操作失败",
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
export default function DomainHealthView({ health }: { health: DomainHealth }) {
	return (
		<div>
			<p className="text-xs text-kumo-subtle mb-3">
				检测于 {new Date(health.checkedAt).toLocaleString("zh-CN")} ·
				检测是时间点快照，DNS 变更后需重新检查。
			</p>
			<div className="divide-y divide-kumo-line">
				{health.checks.map((x) => (
					<div className="py-3" key={x.id}>
						<div className="flex justify-between gap-3 items-center">
							<h3 className="text-xs font-medium">{x.label}</h3>
							<HealthState state={x.state} />
						</div>
						<p className="text-xs text-kumo-subtle leading-6 mt-1">
							{x.detail}
						</p>
						{!!x.records?.length && (
							<details className="mt-1 text-[11px] text-kumo-subtle">
								<summary className="cursor-pointer">查看实际记录</summary>
								<pre className="whitespace-pre-wrap break-all mt-2">
									{x.records.join("\n")}
								</pre>
							</details>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
