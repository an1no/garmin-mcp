import { describe, expect, it } from "vitest";
import { GarminApiError } from "../src/garmin";
import { fetchNutrition, shapeNutritionDay } from "../src/nutrition";
import { fakeGarmin } from "./helpers";

// Synthetic log shaped like /nutrition-service/food/logs/{date}.
const dayLog = (calories: number) => ({
	mealDate: "2026-11-25",
	dailyNutritionContent: { calories, carbs: 250.44, protein: 120.06, fat: 70.5 },
	dailyNutritionGoals: { calories: 2000, adjustedCalories: 2350, carbs: 250, adjustedCarbs: 290, protein: 130, fat: 70 },
	mealDetails: [
		{
			meal: { mealName: "Breakfast", defaultMealName: "BREAKFAST" },
			mealNutritionContent: { calories: 450, carbs: 60, protein: 25, fat: 12 },
			loggedFoods: [
				{
					foodMetaData: { foodName: "Oatmeal", brandName: "Some Brand", foodImageUrl: "https://img.example/oat.png" },
					servingQty: 1.5,
					mealTime: "08:00:00",
					nutritionContent: { calories: 300, carbs: 54, protein: 10, fat: 6, fiber: 8, sugar: 1.04, sodium: 4.6, servingUnit: "cup" },
				},
			],
		},
		{ meal: { defaultMealName: "SNACKS" }, mealNutritionContent: { calories: 0 }, loggedFoods: [] },
	],
	loggedFoodsWithServingSizes: [{ foodMetaData: { foodName: "Oatmeal" } }],
});

describe("shapeNutritionDay", () => {
	it("totals, adjusted goals, remaining calories, meals with foods; empty meals and image URLs dropped", () => {
		expect(shapeNutritionDay(dayLog(1900), "2026-11-25")).toEqual({
			date: "2026-11-25",
			logged: true,
			totals: { calories: 1900, carbsG: 250.4, proteinG: 120.1, fatG: 70.5 },
			goals: { calories: 2350, carbsG: 290, proteinG: 130, fatG: 70 },
			remainingCalories: 450,
			meals: [
				{
					meal: "Breakfast",
					calories: 450,
					carbsG: 60,
					proteinG: 25,
					fatG: 12,
					foods: [
						{
							name: "Oatmeal",
							brand: "Some Brand",
							servings: 1.5,
							servingUnit: "cup",
							time: "08:00",
							calories: 300,
							carbsG: 54,
							proteinG: 10,
							fatG: 6,
							fiberG: 8,
							sugarG: 1,
							sodiumMg: 5,
						},
					],
				},
			],
		});
	});

	it("a day with nothing logged says so and keeps the goals", () => {
		expect(shapeNutritionDay({ dailyNutritionContent: { calories: 0 }, dailyNutritionGoals: { calories: 2000 } }, "2026-11-25")).toEqual({
			date: "2026-11-25",
			logged: false,
			goals: { calories: 2000 },
			message: "No food logged for this date.",
		});
		expect(shapeNutritionDay(null, "2026-11-25")).toMatchObject({ logged: false });
	});
});

describe("fetchNutrition", () => {
	it("one day: one request without media, the full log", async () => {
		const g = fakeGarmin(() => dayLog(1900));
		const r = (await fetchNutrition(g.client, { startDate: "2026-11-25", endDate: "2026-11-25" })) as Record<string, any>;
		expect(g.calls).toEqual([{ path: "/nutrition-service/food/logs/2026-11-25", query: { includeMedia: false } }]);
		expect(r.meals).toHaveLength(1);
	});

	it("a range: one request per day, daily totals, averages over logged days only; 404 means not logged", async () => {
		const g = fakeGarmin((path) => {
			const date = path.split("/").at(-1)!;
			if (date === "2026-11-21") throw new GarminApiError("Not found", 404, path);
			if (date === "2026-11-22") return { dailyNutritionContent: { calories: 0 } };
			return dayLog(date === "2026-11-20" ? 2000 : 1800);
		});
		const r = (await fetchNutrition(g.client, { startDate: "2026-11-20", endDate: "2026-11-23" })) as Record<string, any>;
		expect(g.calls.map((c) => c.path.split("/").at(-1))).toEqual(["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"]);
		expect(g.tokenCalls).toBe(1);
		expect(r.daysLogged).toBe(2);
		expect(r.averagesOnLoggedDays).toMatchObject({ calories: 1900 });
		expect(r.days.map((d: { date: string; logged: boolean }) => [d.date, d.logged])).toEqual([
			["2026-11-20", true],
			["2026-11-21", false],
			["2026-11-22", false],
			["2026-11-23", true],
		]);
		expect(r.days[0]).toMatchObject({ calories: 2000, goalCalories: 2350 });
	});

	it("a range with nothing logged says so", async () => {
		const g = fakeGarmin(() => null);
		const r = (await fetchNutrition(g.client, { startDate: "2026-11-20", endDate: "2026-11-21" })) as Record<string, any>;
		expect(r.daysLogged).toBe(0);
		expect(r.message).toMatch(/No food logged/);
		expect(r).not.toHaveProperty("averagesOnLoggedDays");
	});

	it("other Garmin errors are not hidden", async () => {
		const g = fakeGarmin((path) => {
			throw new GarminApiError("Rate limited by Garmin - wait a bit and try again.", 429, path);
		});
		await expect(fetchNutrition(g.client, { startDate: "2026-11-25", endDate: "2026-11-25" })).rejects.toThrow(/Rate limited/);
	});
});
