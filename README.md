# Final-MVP-submission

# Problem

CPD’s current stocking and supply software (FoodPro) is over 26 years old and lacks modern forecasting capabilities. As a result, forecasting is done entirely manually, and staff must also manually document product expiration dates.
This creates inefficiencies and risks across the system. Without predictive tools, staff rely on estimation, which can lead to overstocking (causing food waste and increased costs) or understocking (causing shortages and service disruptions).
“The goal is to have software which looks at the dining hall’s stock and gives its manager a rundown of what they need to get.”
Additionally, CPD faces budget constraints and cannot secure approval for expensive enterprise systems, creating a need for a cost-effective, intelligent solution that improves decision-making without replacing existing infrastructure.

# Solution
## About the Model:
Our solution uses XGBoost, a gradient-boosted machine learning algorithm, to predict semester-level demand for each inventory item. The model learns from historical usage patterns, recent consumption trends, and Penn State's academic calendar to generate accurate, forward-looking order quantity recommendations.
To improve robustness and reliability, predictions are rounded to whole units and include a 5% buffer to prevent stockouts. This provides staff with a practical, data-driven alternative to manual forecasting while maintaining operational safety.

## About the Data:

To support the model, the Central Procurement Department (CPD) provided purchasing and inventory data for over 2,000 products used within dining commons. This dataset includes shelf life, monthly usage, and seasonal consumption trends for each item.
By leveraging this comprehensive and structured dataset, our model is able to capture real-world patterns and generate accurate predictions under current operating conditions.

# Benefits + Impact

Our FoodBridge system is an updated, AI-powered enhancement of FoodPro that enables CPD to make faster, more accurate, and more informed purchasing decisions. It supports both internal warehouses and external suppliers by creating optimized and predictable ordering patterns.

## Benefit
FoodBridge improves decision-making across PSU’s dining supply chain by providing clear, actionable insights. CPD can quickly identify risks such as overstocking, understocking, and potential expiration issues, allowing staff to act proactively rather than reactively.
The internal warehouse benefits from improved planning of storage capacity and delivery schedules, reducing bottlenecks and inefficiencies. External suppliers gain more consistent and predictable order patterns, enabling better coordination and alignment with pricing tiers and delivery logistics.
Additionally, the system reduces manual workload, allowing staff to shift their focus from repetitive tracking tasks to higher-level operational decisions.

## Impact

With FoodBridge, PSU can significantly reduce food waste, lower procurement costs, and streamline operations across its dining supply chain. By replacing manual estimation with AI-driven forecasting, the system increases overall efficiency and reliability.
CPD staff are empowered to make more strategic decisions, while warehouse operations become smoother and more predictable. At the same time, suppliers benefit from improved demand visibility, strengthening collaboration across the supply chain.
Beyond Penn State, this solution has strong scalability potential and can be adapted to other universities, hospitals, and large-scale dining systems, enabling broader impact in reducing waste and improving supply chain efficiency.
