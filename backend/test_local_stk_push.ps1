$body = @{
  msisdn = "2547XXXXXXXX"
  amount = 1
  reference = "BILL_REF_001"
} | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:3001/api/haskback_push" -Method Post -Body $body -ContentType "application/json"
