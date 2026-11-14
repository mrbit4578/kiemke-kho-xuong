# Chuẩn nguồn dữ liệu nhu cầu vật tư

Ứng dụng chuẩn hóa nguồn về các thực thể: `productionOrders`, `chemicalNorms`, `materials`, `bom` và `importMeta`. File nguồn được đọc trong trình duyệt và không được đưa vào GitHub.

## 1. Tiến độ đơn hàng

Nguồn: `TIEN-DO-SX-DONHANG.xlsx`, sheet `New`.

| Trường chuẩn | Cột nguồn |
| --- | --- |
| `salesOrder` | Số SO#/WI# |
| `purchaseOrder` | Số PO |
| `orderNo` | Chỉ lệnh ĐH |
| `model` / `color` | Mã hàng / Màu |
| `plannedQty` / `productionQty` | SL đơn hàng / Số lượng lệnh sản xuất |
| `stageQuantities.LAF_CUT` | Chặt — nhóm vật tư Nhà máy LAF / Hóa mẫu LAF |
| `stageQuantities.LVF_SEW` | May — nhóm vật tư Nhà máy LVF / Hóa mẫu LVF |
| `stageQuantities.LVF_GO` | Gò — Nhà máy LVF / Hóa mẫu LVF |
| `stageQuantities.RECEIVED`, `PACKED`, `SHIPPED` | Nhập kho, Đóng thùng, Giao hàng |

Khóa ghép chính là `Chỉ lệnh ĐH + Mã hàng + Màu`. PO, khách hàng, ngày giao và các sản lượng theo công đoạn vẫn được giữ để đối chiếu. Các số ở công đoạn được lưu riêng, không cộng thành một số WIP vì chúng mô tả các bước khác nhau.

## 2. Định mức Hóa mẫu

Nguồn: sheet `DM-NPL-DH` trong workbook định mức. Mỗi dòng chuẩn là một vật tư trong một công thức/cụm sản xuất của một chỉ lệnh.

| Trường chuẩn | Cột nguồn |
| --- | --- |
| `purchaseOrder`, `productionOrder` | Số PO, Chỉ lệnh ĐH |
| `model`, `colorCode`, `color` | Mã hàng, Mã màu, Màu |
| `sourceOrderQty` | SL đơn hàng |
| `component`, `formulaName` | Loại, Tên công thức |
| `materialGroup`, `materialCode`, `materialName`, `unit` | Nhóm vừa, Mã vật tư, Tên vật tư, Đơn vị |
| `sourceQuantity` | Số lượng hóa chất |

Nhu cầu tính bằng `sourceQuantity ÷ sourceOrderQty × productionQty`. Đơn vị, mã màu, loại/cụm, công thức và dòng nguồn được giữ nguyên để xem lại chi tiết. Bộ định mức hiện có được nhập vào tác vụ **Định mức Hóa mẫu · LAF**. Tác vụ Hóa mẫu LVF nhận file riêng; không tự sao chép định mức LAF sang LVF.

## 3. BOM vật tư cấp trực tiếp tại xưởng

Danh mục/BOM chuẩn đến từ sheet `1_Danh_Muc_Va_Ma_Tran_BOM` hoặc workbook BOM dạng dọc. BOM dọc hỗ trợ các trường `Kho nhận`, `Nhà máy`, `Công đoạn sử dụng` và `Luồng cấp phát`.

- Nếu có `Công đoạn sử dụng`, số lượng còn cần tại công đoạn = `max(0, SL lệnh sản xuất − số lượng ở cột công đoạn tương ứng)`: Chặt → LAF, May → LVF, Gò → LVF. Đây là cách tính theo ví dụ kiểm kê, trong đó số đã qua công đoạn được trừ khỏi lượng cần sản xuất.
- Nếu BOM không khai báo công đoạn, lượng tính lấy theo `Số lượng lệnh sản xuất`.
- Kho nhận dùng trực tiếp `Kho nhận`/`Nhà máy`; nếu không có, chỉ tự nhận khi danh mục gắn đúng một nhà máy LAF hoặc LVF.
- Vật tư gắn nhiều nhà máy mà BOM không ghi kho nhận được đưa vào danh sách mapping còn thiếu. Ứng dụng không tự nhân định mức cho nhiều kho.
- Mã màu mô tả trên tiến độ được đổi sang mã màu BOM từ mã màu của định mức theo chỉ lệnh. Các trường hợp không có định mức màu làm khóa đối chiếu được báo là chưa ghép.
- Với đơn hàng chưa có mã màu trong định mức Hóa mẫu, nạp task `product-mapping` để nối `Mã sản phẩm nguồn` hoặc cặp `Mã hàng nguồn + Tên màu nguồn` với cặp `Mã hàng BOM + Mã màu BOM`.

Định mức hóa chất hiện không có trường công đoạn lắp ráp tương ứng, nên nhu cầu Hóa mẫu hiển thị theo toàn bộ `Số lượng lệnh sản xuất`, với định mức / đôi lấy từ workbook nguồn. Không diễn giải phần này thành lượng chưa cấp phát theo công đoạn nếu chưa có lịch sử xuất vật tư/công đoạn tiêu thụ.

## 4. Bốn kho và tình trạng nguồn

| Kho kết quả | Nguồn cần có | Xử lý khi thiếu |
| --- | --- | --- |
| Hóa mẫu LAF | Định mức hóa chất LAF + tiến độ lệnh | Không có dòng ghép thì để trống hoặc báo dòng chưa ghép |
| Hóa mẫu LVF | Định mức Hóa mẫu LVF + tiến độ lệnh | Không dùng định mức LAF thay thế |
| Xưởng LAF | BOM trực tiếp + kho nhận LAF + tiến độ | Dòng vật tư đa nhà máy chưa chỉ kho nhận được báo mapping thiếu |
| Xưởng LVF | BOM trực tiếp + kho nhận LVF + tiến độ | Dòng vật tư đa nhà máy chưa chỉ kho nhận được báo mapping thiếu |

Màn hình và file Excel xuất cung cấp số lượng theo từng vật tư, có thể mở chi tiết theo chỉ lệnh. Số lượng ở các đơn vị khác nhau không bị cộng chung thành một tổng không cùng đơn vị.

## 5. Lưu trữ và đồng bộ

- Khi chưa cấu hình Supabase, workbook nhập và kết quả được lưu trên IndexedDB của trình duyệt này. IndexedDB hỗ trợ bộ định mức lớn hơn giới hạn localStorage.
- Khi dùng Supabase, các dòng chuẩn lưu trong `production_order`, `product_mapping`, `chemical_norm`, `import_meta`; chạy lại `supabase/schema.sql` để cập nhật constraint trước khi dùng.
- Mỗi lần nhập nguồn tạo `batchId`; ứng dụng chỉ tính theo lô mới nhất của tác vụ, tránh trộn dòng cũ còn lại từ lần nhập trước.
- Tệp xlsx/csv của doanh nghiệp được loại khỏi repo bằng `.gitignore`.

## 6. Trình tự nạp để xem đủ bốn kho

1. Nhập `TIEN-DO-SX-DONHANG.xlsx` vào tác vụ **Tiến độ & lệnh sản xuất**. Đây là lô chỉ lệnh hiện hành.
2. Nhập workbook định mức Hóa mẫu LAF vào **Định mức Hóa mẫu · LAF**. Khóa nối phải có Chỉ lệnh ĐH, Mã hàng và Màu trùng với tiến độ.
3. Nhập workbook danh mục vào **Danh mục vật tư**, rồi nhập ma trận mã hàng-màu vào **Định mức BOM trực tiếp**. Có thể dùng cùng workbook nguồn cho cả hai tác vụ.
4. Nhập các cặp mã hàng-màu chưa ghép được vào **Mapping mã hàng - màu BOM**. Mapping thủ công được ưu tiên hơn mã màu suy ra từ định mức; nhập riêng khi màu nguồn và mã màu BOM không cùng chuẩn.
5. Khi có nguồn định mức Hóa mẫu LVF riêng, nạp nguồn đó vào tác vụ LVF. Không dùng file LAF thay cho LVF.
6. Mở **Nhu cầu vật tư lý thuyết**, chọn từng kho, xuất chi tiết và kiểm tra trang `ChuaGhepDuoc`. Vật tư dùng nhiều nhà máy cần khai báo kho nhận cho từng dòng BOM.

Các file đã đọc hiện chưa cung cấp định mức Hóa mẫu LVF riêng và chưa có dòng BOM trực tiếp cho kho xưởng LVF. Hai kết quả đó vì vậy được đánh dấu thiếu nguồn/thiếu mapping; ứng dụng không tự tạo số lượng thay thế.
