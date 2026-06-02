@echo off
cd /D "C:\Users\user\Desktop\claude\branddot_new"
node scrape_daily.js >> logs\daily.log 2>&1
