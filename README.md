# Kiểm kê kho xưởng

Ứng dụng web tiếng Việt chuyển luồng theo dõi từ workbook sang các màn hình Tổng quan, Đơn hàng, Kiểm kê, Danh mục/BOM và Định mức BTP theo size cho nhà máy LAF.

## Dữ liệu

- Danh mục workbook: nạp sheet `1_Danh_Muc_Va_Ma_Tran_BOM`, bảng kiểm kê của Hóa mẫu/LAF/LVF và sheet `DM_BTP_Size_LAF`.
- File `DON HANG.xlsx`: chỉ đọc sheet `ADIDAS` và `LƯU HÓA`; sheet `BTP` được bỏ qua. Đơn ADIDAS được gán LAF, đơn LƯU HÓA được gán Hóa mẫu.
- Repo không chứa workbook hoặc dữ liệu mẫu. Hãy nhập file tại nút **Nhập Excel** sau khi mở ứng dụng.
- Chưa kết nối Supabase: dữ liệu lưu trong local storage của trình duyệt hiện tại, chưa dùng chung giữa máy tính/người dùng.

## Chạy trên máy

```bash
npm install
npm run dev
```

## Bật dữ liệu dùng chung

1. Tạo project Supabase và chạy toàn bộ `supabase/schema.sql` trong SQL Editor.
2. Tạo tài khoản đầu tiên trong Supabase Auth. Đăng nhập ứng dụng lần đầu sẽ tạo workspace mặc định.
3. Tạo thêm tài khoản cho nhân viên trong Supabase Auth. Với từng nhân viên, thêm quyền vào workspace bằng SQL, thay hai giá trị UUID:

   ```sql
   insert into public.workspace_members (workspace_id, user_id, role)
   select id, 'USER_UUID', 'editor'
   from public.workspaces
   where name = 'Kho xưởng 3 nhà máy'
   limit 1;
   ```

4. Khai báo `VITE_SUPABASE_URL` và `VITE_SUPABASE_ANON_KEY` trong `.env.local` để chạy local và trong Vercel Project Settings để deploy. Sau đó chạy lại build/deploy.
5. `workspace_records` bật Row Level Security. Chỉ dùng publishable/anon key ở trình duyệt; không đưa `service_role` key vào `VITE_*` hoặc repo.

## Deploy Vercel

Repo này dùng Vite; Vercel tự phát hiện cấu hình build (`npm run build`) và thư mục output `dist`. Có thể kết nối GitHub repo để tự deploy mỗi lần push `main`, hoặc deploy bằng Vercel CLI.

## Ghi chú nghiệp vụ

- Vật tư được gắn với một hoặc nhiều nhà máy; cùng STT có thể dùng ở LAF, LVF và Hóa mẫu.
- BOM được lưu dạng từng dòng mã hàng-màu-vật tư, không cần tạo hàng trăm cột màu.
- Kiểm kê tính tồn lý thuyết theo `Lĩnh về − Sản xuất quy đổi WIP`; chênh lệch bằng kiểm kê thực tế trừ tồn lý thuyết.
- Dòng đơn hàng gắn với nhà máy chính; WIP được nhập riêng theo từng nhà máy.
- Import Excel xử lý trong trình duyệt. Khi có Supabase, các bản ghi được lưu theo workspace; khi chưa cấu hình Supabase, dữ liệu chỉ ở trình duyệt đó.
