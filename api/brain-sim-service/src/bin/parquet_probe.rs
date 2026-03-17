use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::record::Field;
use std::env;
use std::fs::File;
use std::path::Path;

fn field_to_string(field: &Field) -> String {
    match field {
        Field::Null => "NULL".to_string(),
        Field::Bool(v) => v.to_string(),
        Field::Byte(v) => v.to_string(),
        Field::Short(v) => v.to_string(),
        Field::Int(v) => v.to_string(),
        Field::Long(v) => v.to_string(),
        Field::UByte(v) => v.to_string(),
        Field::UShort(v) => v.to_string(),
        Field::UInt(v) => v.to_string(),
        Field::ULong(v) => v.to_string(),
        Field::Float(v) => v.to_string(),
        Field::Double(v) => v.to_string(),
        Field::Str(v) => v.to_string(),
        Field::Bytes(v) => format!("{:?}", v.data()),
        other => format!("{:?}", other),
    }
}

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let path = env::args().nth(1).ok_or("usage: parquet_probe <path>")?;
    let path_ref = Path::new(&path);
    let file = File::open(path_ref)?;
    let reader = SerializedFileReader::new(file)?;
    let meta = reader.metadata();
    println!(
        "parquet_probe: path={} row_groups={} rows={}",
        path_ref.display(),
        meta.num_row_groups(),
        meta.file_metadata().num_rows()
    );

    let schema = meta.file_metadata().schema_descr();
    let mut names = Vec::with_capacity(schema.num_columns());
    for col in schema.columns() {
        names.push(col.path().string());
    }
    println!("columns: {}", names.join(", "));

    let mut iter = reader.get_row_iter(None)?;
    for idx in 0..3 {
        let Some(row) = iter.next() else {
            break;
        };
        let row = row?;
        let mut kv = Vec::new();
        for (name, field) in row.get_column_iter() {
            kv.push(format!("{}={}", name, field_to_string(field)));
        }
        println!("row[{idx}]: {}", kv.join(", "));
    }

    Ok(())
}
