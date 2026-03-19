import pandas as pd
import numpy as np

# 1. Load your file
# Make sure the file is in the same folder as this script
filename = 'Data for Analysis.xlsx - Inventory.csv'
df = pd.read_csv(filename)

# 2. Identify Month Columns (Based on your file structure)
# These are the columns containing the monthly usage counts
month_cols = df.columns[10:22].tolist()

# 3. Peak Seasonality Analysis (Whole Year Scan)
# This calculates every 3-month average across the year to find the "True Peak"
rolling_3mo = df[month_cols].rolling(window=3, axis=1).mean()
df['Peak_3mo_Avg'] = rolling_3mo.max(axis=1)
df['Yearly_Avg'] = df[month_cols].mean(axis=1)

# Identify which months the peak occurred
def find_peak_window(row_idx):
    if df.iloc[row_idx]['Peak_3mo_Avg'] == 0:
        return "No Usage"
    max_idx = rolling_3mo.iloc[row_idx].argmax()
    end_date = month_cols[max_idx].split('-')[1]
    start_date = month_cols[max_idx-2].split('-')[0]
    return f"{start_date} to {end_date}"

df['Peak_Season'] = [find_peak_window(i) for i in range(len(df))]
df['Seasonality_Index'] = np.where(df['Yearly_Avg'] > 0, df['Peak_3mo_Avg'] / df['Yearly_Avg'], 0)

# 4. Growth & Momentum
# Compares the first 3 months vs the last 3 months
first_3_avg = df[month_cols[:3]].mean(axis=1)
last_3_avg = df[month_cols[-3:]].mean(axis=1)
df['Growth_Rate'] = np.where(first_3_avg > 0, (last_3_avg - first_3_avg) / first_3_avg, 
                             np.where(last_3_avg > 0, 1.0, 0))

# 5. Stability & Frequency
df['Volatility_CV'] = np.where(df['Yearly_Avg'] > 0, df[month_cols].std(axis=1) / df['Yearly_Avg'], 0)
df['Active_Months'] = (df[month_cols] > 0).sum(axis=1)

# 6. Classifications
def categorize_demand(row):
    if row['Active_Months'] >= 10: return 'Constant (High Reliability)'
    if row['Active_Months'] >= 4:  return 'Seasonal (Cyclical)'
    if row['Active_Months'] > 0:   return 'Sporadic (Unpredictable)'
    return 'Inactive'

df['Demand_Pattern'] = df.apply(categorize_demand, axis=1)

# ABC Analysis (Categorizing items by their impact on total volume)
df = df.sort_values('Total Usage', ascending=False)
df['Cum_Usage_Pct'] = df['Total Usage'].cumsum() / df['Total Usage'].sum()
df['Volume_Class'] = np.where(df['Cum_Usage_Pct'] <= 0.8, 'A (Top 80%)', 
                              np.where(df['Cum_Usage_Pct'] <= 0.95, 'B (Middle 15%)', 'C (Bottom 5%)'))

# 7. Final Report Export
output_cols = [
    'Item Name', 'Pack', 'Total Usage', 'Volume_Class', 'Demand_Pattern', 
    'Active_Months', 'Peak_Season', 'Seasonality_Index', 'Growth_Rate', 'Volatility_CV'
]
df[output_cols].to_csv('Inventory_Master_Analysis.csv', index=False)

print("Analysis complete! File saved as 'Inventory_Master_Analysis.csv'")