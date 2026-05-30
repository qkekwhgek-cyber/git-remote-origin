import smtplib
import os
import sys
import glob
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

def find_latest_report():
    files = sorted(glob.glob('daily-reports/*.md'))
    if not files:
        print('ERROR: daily-reports/ 에 .md 파일이 없습니다')
        sys.exit(1)
    return files[-1]

def send_report():
    user = os.environ['GMAIL_USER']
    password = os.environ['GMAIL_PASSWORD']

    report_file = find_latest_report()
    date = os.path.basename(report_file).replace('.md', '')

    with open(report_file, 'r', encoding='utf-8') as f:
        content = f.read()

    msg = MIMEMultipart('alternative')
    msg['Subject'] = f'일일 트렌드 리포트 - {date}'
    msg['From'] = user
    msg['To'] = user

    msg.attach(MIMEText(content, 'plain', 'utf-8'))

    with smtplib.SMTP_SSL('smtp.gmail.com', 465) as smtp:
        smtp.login(user, password)
        smtp.send_message(msg)

    print(f'이메일 발송 완료: {date} → {user}')

if __name__ == '__main__':
    send_report()
