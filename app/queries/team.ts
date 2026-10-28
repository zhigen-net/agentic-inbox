import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";
export function useMe(enabled = true) {
	return useQuery({
		queryKey: ["me"],
		queryFn: api.getMe,
		retry: false,
		enabled,
	});
}
