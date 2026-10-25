import { Injectable } from "@nestjs/common";

@Injectable()
export class HealthService {
	live(): { status: "ok" } {
		return { status: "ok" };
	}
}
