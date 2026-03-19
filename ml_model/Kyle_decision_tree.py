import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.neighbors import NearestNeighbors
from sklearn.model_selection import train_test_split

np.random.seed(42)
num_items = 1000

# ==========================================
# 1. Mocking Scraped Retail & Nutrition Data
# ==========================================
item_ids = np.arange(num_items)
item_embeddings = np.random.rand(num_items, 10) # ANN semantic vectors

# Simulating a clean database table after scraping retail sites
item_features = pd.DataFrame({
    'item_id': item_ids,
    # Retail Logistics
    'price_per_100g': np.random.uniform(0.10, 3.50, size=num_items), # $0.10 to $3.50
    'in_stock_locally': np.random.choice([0, 1], p=[0.2, 0.8], size=num_items), # 80% chance in stock
    
    # Standardized Macros (per 100g basis)
    'calories_per_100g': np.random.randint(50, 600, size=num_items),
    'protein_g': np.random.uniform(0, 30, size=num_items),
    'total_fat_g': np.random.uniform(0, 40, size=num_items),
    'carbohydrates_g': np.random.uniform(0, 80, size=num_items),
    'dietary_fiber_g': np.random.uniform(0, 20, size=num_items),
    'added_sugars_g': np.random.uniform(0, 40, size=num_items),
    'sodium_mg': np.random.uniform(0, 1000, size=num_items)
})

# ==========================================
# 2. Train the ANN (Candidate Generation)
# ==========================================
ann_index = NearestNeighbors(n_neighbors=50, algorithm='auto')
ann_index.fit(item_embeddings)

# ==========================================
# 3. Train the XGBoost Ranker (GBDT)
# ==========================================
historical_data = item_features.copy()

# Mock Community Context Features
historical_data['community_diabetes_rate'] = np.random.uniform(0.05, 0.20, size=num_items) # 5% to 20%
historical_data['children_under_18_pct'] = np.random.uniform(0.15, 0.35, size=num_items)

# Define the "Urgency/Relevance Score" (Target Variable)
# The model will learn this underlying logic during training:
# 1. MUST be in stock.
# 2. Cheaper per 100g is better.
# 3. Penalize high added sugars heavily IF diabetes rate is high.
# 4. Reward high protein/fiber.
historical_data['relevance_score'] = (
    (historical_data['in_stock_locally'] * 0.4) + 
    ((3.50 - historical_data['price_per_100g']) / 3.50 * 0.3) + 
    (historical_data['protein_g'] / 30 * 0.2) +
    (historical_data['dietary_fiber_g'] / 20 * 0.2) -
    (historical_data['community_diabetes_rate'] * (historical_data['added_sugars_g'] / 40) * 0.4) 
).clip(0, 1)

X = historical_data.drop(columns=['item_id', 'relevance_score'])
y = historical_data['relevance_score']

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

ranker = xgb.XGBRegressor(
    objective='reg:squarederror',
    n_estimators=100,
    learning_rate=0.1,
    max_depth=5
)
ranker.fit(X_train, y_train)

# ==========================================
# 4. The Inference Pipeline
# ==========================================
def recommend_retail_items(community_need_vector, diabetes_rate, child_pct):
    print("Step 1: ANN generating candidates...")
    distances, indices = ann_index.kneighbors([community_need_vector])
    candidate_ids = item_ids[indices[0]]
    
    candidates_df = item_features[item_features['item_id'].isin(candidate_ids)].copy()
    
    # Inject real-time community context
    candidates_df['community_diabetes_rate'] = diabetes_rate
    candidates_df['children_under_18_pct'] = child_pct
    
    print("Step 2: GBDT Ranking for nutritional and budget efficiency...")
    features_for_ranking = candidates_df.drop(columns=['item_id'])
    
    candidates_df['predicted_relevance'] = ranker.predict(features_for_ranking)
    
    # Filter out anything not currently in stock locally before returning
    in_stock_candidates = candidates_df[candidates_df['in_stock_locally'] == 1]
    
    final_recommendations = in_stock_candidates.sort_values(by='predicted_relevance', ascending=False)
    
    return final_recommendations[['item_id', 'predicted_relevance', 'price_per_100g', 'protein_g', 'added_sugars_g']]

# --- Test the Pipeline ---
current_need_vector = np.random.rand(10) 
top_needs = recommend_retail_items(
    community_need_vector=current_need_vector, 
    diabetes_rate=0.18, # High diabetes rate area
    child_pct=0.25
)

print("\nTop 5 Most Efficient & Nutritionally Appropriate Items to Source:")
print(top_needs.head(10))