/**
 * get_nutrition: food logged in Garmin Connect. One day gives meals and foods; a short range
 * gives daily totals against the goals. Garmin only has this data for people who log food.
 */
import { GarminApiError, type GarminClient } from "./garmin";
import { addDays, compact, daysInclusive, num, round } from "./format";
import { mapLimit } from "./parts";

type Json = Record<string, unknown>;

/** One request per day, so ranges stay short. */
export const NUTRITION_MAX_DAYS = 14;
const CONCURRENCY = 3;

function obj(value: unknown): Json {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function arr(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** Calories and macronutrients from a Garmin nutrition-content object. */
function macros(value: unknown) {
	const n = obj(value);
	return { calories: round(n.calories, 0), carbsG: round(n.carbs, 1), proteinG: round(n.protein, 1), fatG: round(n.fat, 1) };
}

/** Goals, preferring Garmin's "adjusted" values (which include calories burned by activity). */
function goals(value: unknown) {
	const g = obj(value);
	return compact({
		calories: round(g.adjustedCalories ?? g.calories, 0),
		carbsG: round(g.adjustedCarbs ?? g.carbs, 0),
		proteinG: round(g.adjustedProtein ?? g.protein, 0),
		fatG: round(g.adjustedFat ?? g.fat, 0),
	});
}

/** /nutrition-service/food/logs/{date} -> totals, goals and meals with their foods. */
export function shapeNutritionDay(raw: unknown, date: string): Json {
	const d = obj(raw);
	const meals = arr(d.mealDetails)
		.map(obj)
		.map((m) => {
			const meal = obj(m.meal);
			const foods = arr(m.loggedFoods)
				.map(obj)
				.map((f) => {
					const meta = obj(f.foodMetaData);
					const n = obj(f.nutritionContent);
					return compact({
						name: meta.foodName,
						brand: meta.brandName,
						servings: round(f.servingQty, 2),
						servingUnit: n.servingUnit,
						time: typeof f.mealTime === "string" ? f.mealTime.slice(0, 5) : undefined,
						...macros(n),
						fiberG: round(n.fiber, 1),
						sugarG: round(n.sugar, 1),
						sodiumMg: round(n.sodium, 0),
					});
				});
			return compact({ meal: meal.mealName ?? meal.defaultMealName, ...macros(m.mealNutritionContent), foods });
		})
		.filter((m) => (Array.isArray(m.foods) && m.foods.length > 0) || (num(m.calories) ?? 0) > 0);

	const totals = macros(d.dailyNutritionContent);
	const goal = goals(d.dailyNutritionGoals);
	if (!meals.length && !((totals.calories ?? 0) > 0)) {
		return compact({ date, logged: false, goals: goal, message: "No food logged for this date." });
	}
	const goalCalories = num(goal.calories);
	return compact({
		date,
		logged: true,
		totals,
		goals: goal,
		remainingCalories: goalCalories !== undefined && totals.calories !== undefined ? goalCalories - totals.calories : undefined,
		meals,
	});
}

/** One day's log, or null when Garmin has nothing for that date. */
async function fetchDay(garmin: GarminClient, date: string): Promise<unknown> {
	try {
		return await garmin.get(`/nutrition-service/food/logs/${date}`, { includeMedia: false });
	} catch (error) {
		if (error instanceof GarminApiError && error.status === 404) return null;
		throw error;
	}
}

/** One day: the full log. Several days: daily totals against the goal, plus averages over logged days. */
export async function fetchNutrition(garmin: GarminClient, range: { startDate: string; endDate: string }): Promise<Json> {
	if (range.startDate === range.endDate) {
		return shapeNutritionDay(await fetchDay(garmin, range.startDate), range.startDate);
	}
	await garmin.getAccessToken(); // one token request up front instead of one per parallel call
	const dates = Array.from({ length: daysInclusive(range.startDate, range.endDate) }, (_, i) => addDays(range.startDate, i));
	const days = await mapLimit(dates, CONCURRENCY, async (date) => shapeNutritionDay(await fetchDay(garmin, date), date));

	const rows = days.map((d): Json => {
		const t = obj(d.totals);
		return compact({
			date: d.date,
			logged: d.logged,
			calories: t.calories,
			carbsG: t.carbsG,
			proteinG: t.proteinG,
			fatG: t.fatG,
			goalCalories: obj(d.goals).calories,
		});
	});
	const logged = rows.filter((r) => r.logged === true);
	const average = (key: string, digits: number) => {
		const values = logged.map((r) => num(r[key])).filter((v): v is number => v !== undefined);
		return values.length ? round(values.reduce((a, b) => a + b, 0) / values.length, digits) : undefined;
	};
	return compact({
		...range,
		units: { calories: "kcal", macros: "grams" },
		daysLogged: logged.length,
		averagesOnLoggedDays: logged.length
			? { calories: average("calories", 0), carbsG: average("carbsG", 1), proteinG: average("proteinG", 1), fatG: average("fatG", 1) }
			: undefined,
		message: logged.length ? undefined : "No food logged in this range.",
		days: rows,
	});
}
