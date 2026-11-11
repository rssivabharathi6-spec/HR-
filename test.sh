#!/bin/bash
# Smoke test: starts the server on a temp DB and checks key behaviours.
export DB_FILE=/tmp/test-hr.db PORT=3111; rm -f $DB_FILE*
node server.js > /tmp/server.log 2>&1 & PID=$!; sleep 1.5
B=http://localhost:$PORT/api
login(){ curl -s -X POST $B/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$2\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).token'; }
g(){ curl -s -w ' [%{http_code}]\n' -H "Authorization: Bearer $1" "$B$2"; }
j(){ curl -s -w ' [%{http_code}]\n' -X $2 -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -d "$4" "$B$3"; }
HR=$(login hr@company.com hr123); MG=$(login manager@company.com mgr123); EM=$(login employee@company.com emp123)
echo "1 wrong password:"; curl -s -w ' [%{http_code}]\n' -X POST $B/auth/login -H 'Content-Type: application/json' -d '{"email":"hr@company.com","password":"x"}'
echo "2 no token:"; curl -s -w ' [%{http_code}]\n' $B/me
echo "3 employee -> attrition risk (expect 403):"; g $EM /analytics/attrition-risk
echo "4 employee -> candidates (expect 403):"; g $EM /candidates
echo "5 HR -> attrition risk:"; g $HR /analytics/attrition-risk | head -c 400; echo
echo "6 employee applies 2 casual leave:"; j $EM POST /leave '{"type":"Casual","days":2}'
echo "7 employee applies 99 days (expect 400):"; j $EM POST /leave '{"type":"Casual","days":99}'
echo "8 employee approves own leave (expect 403):"; j $EM PATCH /leave/2 '{"status":"Approved"}'
echo "9 manager pending:"; g $MG /leave/pending | head -c 300; echo
echo "10 manager approves id 2:"; j $MG PATCH /leave/2 '{"status":"Approved"}'
echo "11 employee balance after:"; g $EM /leave/balance
echo "12 WFH x4 in one week (4th expect 400):"; for d in 2026-11-09 2026-11-10 2026-11-11 2026-11-12; do j $EM PUT /workplan "{\"date\":\"$d\",\"location\":\"WFH\"}"; done
echo "13 pulse summary (HR):"; g $HR /pulse/summary
echo "14 overview (HR):"; g $HR /analytics/overview
echo "15 simulate Ananya (id 3) raise 10 + promotion:"; j $HR POST /analytics/simulate '{"user_id":3,"raise":10,"promotion":true}'
echo "16 SQL injection attempt on login:"; curl -s -w ' [%{http_code}]\n' -X POST $B/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"' OR 1=1 --\",\"password\":\"x\"}"
kill $PID
