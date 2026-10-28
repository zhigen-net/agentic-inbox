import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";
export function useMe() {
	return useQuery({ queryKey: ["me"], queryFn: api.getMe, retry: false });
}
