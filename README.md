# Kiểm kê kho xưởng

Ứng dụng web tiếng Việt chuyển luồng theo dõi từ workbook sang các màn hình Tổng quan, Đơn hàng, Kiểm kê, Danh mục/BOM và Định mức BTP theo size cho nhà máy LAF.

## Dữ liệu

- Menu **Tác vụ nhập liệu** tách riêng tám luồng: đơn hàng, WIP, danh mục vật tư, BOM, kiểm kê Hóa mẫu, kiểm kê LAF, kiểm kê LVF và định mức BTP theo size LAF. Mỗi luồng có Import, Export dữ liệu và Tải mẫu trống.
- Có thể nạp từng phần từ workbook hiện tại: danh mục/BOM từ `1_Danh_Muc_Va_Ma_Tran_BOM`; tồn kho từ từng sheet `2_Kho_Hoa_Mau`, `3_Kho_Xuong_LAF`, `4_Kho_Xuong_LVF`; định mức từ `DM_BTP_Size_LAF`.
- File `DON HANG.xlsx`: chỉ đọc sheet `ADIDAS` và `LƯU HÓA`; sheet `BTP` được bỏ qua. Đơn ADIDAS được gán LAF, đơn LƯU HÓA được gán Hóa mẫu.
- File Export là `.xlsx` theo từng tác vụ. BOM được xuất dạng danh sách dọc, nên số mã hàng-màu không bị giới hạn bởi số cột mẫu. File chỉ chứa dữ liệu đầu vào; không ghi công thức Excel. Nhu cầu, WIP, tồn lý thuyết và chênh lệch được tính trong ứng dụng.
- Repo không chứa workbook hoặc dữ liệu mẫu. Hãy dùng **Tác vụ nhập liệu** sau khi mở ứng dụng.
- Chưa kết nối Supabase: dữ liệu lưu trong local storage của trình duyệt hiện tại, chưa dùng chung giữa máy tính/người dùng.

## Chạy trên máy

```bash
npm install
npm run dev
```

Chạy kiểm tra và build production:

```bash
npm test
npm run build
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
- BOM được lưu dạng từng dòng mã hàng-màu-vật tư; bộ nhập đọc động các cột màu hiện có trong workbook và file xuất dùng danh sách dọc.
- Kiểm kê tính tồn lý thuyết theo `Lĩnh về − Sản xuất quy đổi WIP`; chênh lệch bằng kiểm kê thực tế trừ tồn lý thuyết.
- Dòng đơn hàng gắn với nhà máy chính; WIP được nhập riêng theo từng nhà máy.
- Import Excel xử lý trong trình duyệt. Khi có Supabase, các bản ghi được lưu theo workspace; khi chưa cấu hình Supabase, dữ liệu chỉ ở trình duyệt đó.
