export const Plans = {
  Premium: "premium",
  Enterprise: "enterprise"
};

export const planValues = Object.values(Plans);
export const defaultPlan = Plans.Premium;

export async function getPlan() {
  const data = await chrome.storage.local.get("plan");
  const plan = data.plan;
  return planValues.includes(plan) ? plan : defaultPlan;
}

export async function setPlan(plan) {
  if (!planValues.includes(plan)) {
    throw new Error(`Invalid plan: ${plan}`);
  }

  await chrome.storage.local.set({ plan });
  return plan;
}
